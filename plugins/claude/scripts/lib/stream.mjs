// Keep progress separate from the final result; partial text is never a pass.
const verification = new RegExp(
  '\\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|' +
    'pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|' +
    'mvn test|gradle test|tsc|eslint|ruff)\\b',
  'i',
);

export function reviewStream(onProgress = () => {}, onSession = () => {}) {
  let pending = '';
  let final;
  let sessionId;
  let diagnostic = '';
  const receive = (line) => {
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      diagnostic = `${diagnostic}\n${line}`;
      return;
    }

    if (!event || typeof event !== 'object') {
      diagnostic = `${diagnostic}\n${line}`;
      return;
    }

    if (event.session_id && event.session_id !== sessionId) {
      sessionId = event.session_id;
      onSession(sessionId);
    }

    if (event.type === 'result') {
      if (final) throw new Error('Claude returned multiple result events.');

      final = event;
    } else if (!event.type) {
      diagnostic = `${diagnostic}\n${line}`;
    } else reportProgress(event, onProgress);
  };
  return {
    write(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        receive(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    finish() {
      receive(pending);
      pending = '';
      return final ? JSON.stringify(final) : diagnostic.trim();
    },
  };
}

function reportProgress(event, notify) {
  if (event.type === 'system' && event.subtype === 'init')
    notify({ phase: 'reviewing', summary: 'Claude initialized.' });

  if (event.type === 'tool_progress') notify(toolProgress(event.tool_name));

  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? [])
      reportBlock(block, notify);
  }

  reportPartial(event, notify);
}

function reportBlock(block, notify) {
  if (block.type === 'tool_use') notify(toolProgress(block.name, block.input));

  if (block.type === 'text' && block.text?.trim())
    notify({ phase: 'reviewing', summary: block.text });
}

function reportPartial(event, notify) {
  const block = event.event?.content_block;
  if (event.type === 'stream_event' && block?.type === 'tool_use')
    notify(toolProgress(block.name, block.input));

  if (event.event?.delta?.type === 'text_delta')
    notify({ phase: 'finalizing', summary: 'Producing output.' });
}

function toolProgress(name, input = {}) {
  let phase = 'investigating';
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) phase = 'editing';
  else if (name === 'Bash') {
    phase = verification.test(input.command || '') ? 'verifying' : 'running';
  }

  return { phase, summary: `Using ${name}.` };
}

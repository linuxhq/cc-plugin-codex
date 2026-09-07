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
  const activeTools = new Map();
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
    } else reportProgress(event, onProgress, activeTools);
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

function reportProgress(event, notify, activeTools) {
  if (event.type === 'system' && event.subtype === 'init')
    notify({ phase: 'reviewing', summary: 'Claude initialized.' });

  if (event.type === 'tool_progress')
    reportToolProgress(event, notify, activeTools);

  if (['assistant', 'user'].includes(event.type)) {
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant') reportBlock(block, notify, activeTools);
      else if (block.type === 'tool_result')
        reportToolResult(block, notify, activeTools);
    }
  }

  reportPartial(event, notify);
}

function reportToolProgress(event, notify, activeTools) {
  const tool = activeTools.get(event.tool_use_id);
  notify(toolProgress(tool?.name || event.tool_name, tool?.input));
}

function reportToolResult(block, notify, activeTools) {
  const tool = activeTools.get(block.tool_use_id);
  activeTools.delete(block.tool_use_id);
  const status = block.is_error ? 'failed' : 'completed';
  const command = tool?.name === 'Bash' && tool.input?.command;
  const summary = command
    ? `Command ${status}: ${command}`
    : `Tool ${tool?.name || block.tool_use_id} ${status}.`;
  const content =
    typeof block.content === 'string'
      ? block.content
      : (block.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
  notify({
    phase: toolProgress(tool?.name, tool?.input).phase,
    summary,
    logBody: content,
  });
}

function reportBlock(block, notify, activeTools) {
  if (block.type === 'tool_use') {
    if (block.id)
      activeTools.set(block.id, { name: block.name, input: block.input });

    notify(toolProgress(block.name, block.input));
  }

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

  return {
    phase,
    summary:
      name === 'Bash' && input.command
        ? `Running command: ${input.command}`
        : `Using ${name}.`,
  };
}

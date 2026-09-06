// Keep progress separate from the final result; partial text is never a pass.
export function reviewStream(onProgress = () => {}) {
  let pending = '';
  let final;
  let diagnostic = '';
  const receive = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      diagnostic = `${diagnostic}\n${line}`.slice(-8192);
      return;
    }
    if (!event || typeof event !== 'object') {
      diagnostic = `${diagnostic}\n${line}`.slice(-8192);
    } else if (event.type === 'result' || (!event.type && event.subtype)) {
      if (final) throw new Error('Claude returned multiple result events.');
      final = event;
    } else if (!event.type) {
      diagnostic = `${diagnostic}\n${line}`.slice(-8192);
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
      if (pending.length > 16 * 1024 * 1024)
        throw new Error('Claude stream event exceeds 16 MiB.');
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
  if (event.type === 'tool_progress')
    notify({ phase: 'reading', summary: `Using ${event.tool_name}.` });
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? [])
      reportBlock(block, notify);
  }
  reportPartial(event, notify);
}

function reportBlock(block, notify) {
  if (block.type === 'tool_use')
    notify({ phase: 'reading', summary: `Using ${block.name}.` });
  if (block.type === 'text' && block.text?.trim())
    notify({ phase: 'reviewing', summary: block.text });
}

function reportPartial(event, notify) {
  const block = event.event?.content_block;
  if (event.type === 'stream_event' && block?.type === 'tool_use')
    notify({ phase: 'reading', summary: `Using ${block.name}.` });
  if (event.event?.delta?.type === 'text_delta')
    notify({ phase: 'writing', summary: 'Producing review output.' });
}

const maxPageBytes = 256 * 1024;

// Buffer only a bounded preview of each record, even for a huge single line.
export function inspectionPage({ offset = 0, limit = 500 } = {}, options = {}) {
  let partial = '';
  let omitted = 0,
    pending = false;
  let index = 0,
    count = 0,
    bytes = 0;
  let next = offset;
  let full = false;
  const output = [];
  const separator = options.separator ?? '\n';
  const append = (piece) => {
    if (piece.length) pending = true;
    if ((index < offset || full) && !options.include) return;
    const buffer = Buffer.from(piece);
    const room = Math.max(0, maxPageBytes - Buffer.byteLength(partial));
    partial += buffer.subarray(0, room).toString('utf8');
    omitted += Math.max(0, buffer.length - room);
  };
  const record = () => {
    pending = false;
    const value = partial;
    const skipped = omitted;
    partial = '';
    omitted = 0;
    if (options.include && !options.include(value)) return;
    const line = index++;
    if (line < offset || full) return;
    const rendered = options.render ? options.render(value) : value;
    const prefix = `${line + 1}: `;
    const room = maxPageBytes - bytes - Buffer.byteLength(prefix) - 100;
    if (room <= 0) {
      full = true;
      return;
    }
    const buffer = Buffer.from(rendered);
    // Retry this whole line on the next page instead of losing its tail merely
    // because preceding lines used the byte budget.
    if (shouldDefer(count, skipped, buffer.length, room)) {
      full = true;
      return;
    }
    const clipped = buffer.subarray(0, room).toString('utf8');
    const lost = skipped + Math.max(0, buffer.length - room);
    const marker = lost ? ` [truncated ${lost} bytes on line ${line + 1}]` : '';
    output.push(prefix + clipped + marker);
    bytes += Buffer.byteLength(prefix + clipped + marker) + 1;
    if (lost) options.onIncomplete?.();
    next = index;
    full = ++count >= limit || lost > 0;
  };
  return {
    write(chunk) {
      splitRecords(chunk, separator, append, record);
    },
    finish() {
      if (pending) record();
      return (
        output.join('\n') +
        `\n[${index} total lines; next offset ${Math.min(next, index)}]`
      );
    },
  };
}

function splitRecords(chunk, separator, append, record) {
  let start = 0;
  for (
    let end = chunk.indexOf(separator);
    end !== -1;
    end = chunk.indexOf(separator, start)
  ) {
    append(chunk.slice(start, end));
    record();
    start = end + separator.length;
  }
  append(chunk.slice(start));
}

function shouldDefer(count, skipped, length, room) {
  return count > 0 && (skipped > 0 || length > room);
}

const maxPageBytes = 256 * 1024;

// Buffer only a bounded preview of each record, even for a huge single line.
export function inspectionPage(
  { offset = 0, limit = 500, byteOffset = 0 } = {},
  options = {},
) {
  let index = 0,
    count = 0,
    bytes = 0;
  let next = offset;
  let nextByte = 0;
  let full = false;
  const output = [];
  const separator = options.separator ?? '\n';
  const lineBuffer = boundedLine(byteOffset);
  const append = (piece) =>
    lineBuffer.append(
      piece,
      index === offset,
      (index < offset || full) && !options.include,
    );
  const record = () => {
    const { value, skipped } = lineBuffer.take();
    if (options.include && !options.include(value)) return;

    const line = index++;
    if (line < offset || full) return;

    const rendered = options.render ? options.render(value) : value;
    const prefix = `${line + 1}: `;
    const room = maxPageBytes - bytes - Buffer.byteLength(prefix) - 100;
    const buffer = Buffer.from(rendered);
    // Retry this whole line on the next page instead of losing its tail merely
    // because preceding lines used the byte budget.
    if (room <= 0 || shouldDefer(count, skipped, buffer.length, room)) {
      full = true;
      return;
    }

    const clipped = utf8Prefix(buffer, room).toString('utf8');
    const lost = skipped + buffer.length - Buffer.byteLength(clipped);
    const marker = lost ? ` [continued: ${lost} bytes remain]` : '';
    output.push(prefix + clipped + marker);
    bytes += Buffer.byteLength(prefix + clipped + marker) + 1;
    next = lost ? line : index;
    nextByte = lost ? continuationByte(line, offset, byteOffset, clipped) : 0;
    full = ++count >= limit || lost > 0;
  };
  return {
    write(chunk) {
      splitRecords(chunk, separator, append, record);
    },
    finish() {
      if (lineBuffer.pending) record();

      return (
        output.join('\n') +
        `\n[${index} total lines; next offset ${Math.min(next, index)}` +
        (nextByte ? `; next byteOffset ${nextByte}` : '') +
        ']'
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

// Never split a UTF-8 code point between pages.
function utf8Prefix(buffer, room) {
  let end = Math.min(buffer.length, Math.max(0, room));
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;

  return buffer.subarray(0, end);
}

function boundedLine(byteOffset) {
  let partial = '';
  let omitted = 0;
  let skip = byteOffset;
  return {
    pending: false,
    append(piece, first, ignore) {
      if (piece.length) this.pending = true;

      if (ignore) return;

      let buffer = Buffer.from(piece);
      if (first && skip) {
        const consumed = Math.min(skip, buffer.length);
        buffer = buffer.subarray(consumed);
        skip -= consumed;
      }

      const room = omitted
        ? 0
        : Math.max(0, maxPageBytes - Buffer.byteLength(partial));
      const kept = utf8Prefix(buffer, room);
      partial += kept.toString('utf8');
      omitted += buffer.length - kept.length;
    },
    take() {
      const result = { value: partial, skipped: omitted };
      partial = '';
      omitted = 0;
      this.pending = false;
      return result;
    },
  };
}

function continuationByte(line, offset, byteOffset, clipped) {
  return (line === offset ? byteOffset : 0) + Buffer.byteLength(clipped);
}

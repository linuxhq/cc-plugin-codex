import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inlineBytes = 256 * 1024;

export async function collectContext(produce, options = {}) {
  const root = options.contextRoot || tmpdir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'review-context-'));
  const path = join(directory, 'changes.patch');
  let keep = false;
  const file = await open(path, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    const preview = [];
    const write = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
      if (bytes <= inlineBytes) preview.push(buffer);
      let offset = 0;
      while (offset < buffer.length)
        offset += writeSync(file.fd, buffer, offset);
    };
    await produce(write);
    keep = bytes > inlineBytes && !options.fingerprintOnly;
    const context =
      bytes > inlineBytes
        ? [
            `The complete review snapshot is ${bytes} bytes.`,
            `Read ${JSON.stringify(path)} in sections using Read or Grep.`,
            'Review the entire snapshot before finalizing findings.',
            'This file preserves the target at launch; do not substitute the',
            'current working tree. Report any portions you could not inspect.',
          ].join('\n')
        : Buffer.concat(preview).toString('utf8');
    return {
      context,
      fingerprint: hash.digest('hex'),
      contextBytes: bytes,
      inputMode: keep ? 'file' : 'inline',
      ...(keep ? { contextDirectory: directory, contextPath: path } : {}),
    };
  } finally {
    await file.close();
    if (!keep) await rm(directory, { recursive: true, force: true });
  }
}

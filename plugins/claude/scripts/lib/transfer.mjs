import { sensitive } from './repository-policy.mjs';
import { isAbsolute, relative, resolve } from 'node:path';
import { constants } from 'node:fs';
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSessionId } from './status.mjs';

const maxBytes = 8 * 1024 * 1024;

export async function readContextFile(path, repo = process.cwd()) {
  if (sensitive.test(resolve(path)))
    throw new Error('Sensitive context paths are not allowed.');
  const canonical = await realpath(path);
  if (sensitive.test(canonical))
    throw new Error('Sensitive context paths are not allowed.');
  const roots = await Promise.all(
    [repo, tmpdir(), process.env.CODEX_HOME || join(homedir(), '.codex')].map(
      (root) => realpath(root).catch(() => resolve(root)),
    ),
  );
  if (
    !roots.some((root) => {
      const rel = relative(root, canonical);
      return (
        rel &&
        rel !== '..' &&
        !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(rel)
      );
    })
  )
    throw new Error(
      'Context must be inside the checkout, temporary ' +
        'directory, or CODEX_HOME. Copy an intended summary there first.',
    );
  if ((await lstat(path)).isSymbolicLink())
    throw new Error('Symlink context inputs are not allowed.');
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('Context must be a regular file of at most 8 MiB.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('Context exceeds 8 MiB.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function transferContext(options, repo = process.cwd()) {
  if (options['prompt-file'])
    return readContextFile(options['prompt-file'], repo);
  const source = options.source || (await findTranscript());
  return transcriptMessages(await readContextFile(source, repo));
}

export function transcriptMessages(text) {
  const turns = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('Invalid Codex JSONL. Use --prompt-file for plain text.');
    }
    const message = record?.type === 'response_item' ? record.payload : null;
    if (!isConversationMessage(message)) continue;
    const content = (message.content || [])
      .filter((part) => ['input_text', 'output_text'].includes(part.type))
      .map((part) => part.text)
      .filter((value) => typeof value === 'string')
      .join('\n');
    if (content.trim()) turns.push({ role: message.role, text: content });
  }
  if (!turns.length) throw new Error('No user or assistant transcript text.');
  return JSON.stringify(turns);
}

function isConversationMessage(message) {
  return (
    message?.type === 'message' &&
    ['user', 'assistant'].includes(message.role) &&
    message.phase !== 'analysis' &&
    Array.isArray(message.content)
  );
}

async function findTranscript() {
  const session = currentSessionId();
  if (!session || !/^[a-f0-9-]{36}$/.test(session))
    throw new Error(
      'Cannot identify Codex session. Pass --source or ' + '--prompt-file.',
    );
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const matches = [];
  for (const directory of ['sessions', 'archived_sessions'])
    await searchTranscripts(join(home, directory), session, matches);
  if (matches.length !== 1)
    throw new Error(
      'Cannot identify one Codex transcript. Pass --source ' +
        'or --prompt-file.',
    );
  return matches[0];
}

async function searchTranscripts(directory, session, matches, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      await searchTranscripts(path, session, matches, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(`${session}.jsonl`))
      matches.push(path);
  }
}

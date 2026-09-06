import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentSessionId } from './status.mjs';

export async function readContextFile(path, repo = process.cwd()) {
  const requested = path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : resolve(repo, path);
  if (extname(requested) !== '.jsonl')
    throw new Error('Codex session source must be a JSONL file.');

  const canonical = await realpath(requested);
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const roots = await Promise.all(
    [join(home, 'sessions'), join(home, 'archived_sessions')].map((root) =>
      realpath(root).catch(() => resolve(root)),
    ),
  );
  if (
    !roots.some((root) => {
      const rel = relative(root, canonical);
      return (
        rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      );
    })
  )
    throw new Error(
      'Transfer source must be inside CODEX_HOME/sessions or ' +
        'CODEX_HOME/archived_sessions.',
    );

  return readFile(canonical, 'utf8');
}

export async function transferContext(options, repo = process.cwd()) {
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
      throw new Error('Invalid Codex JSONL transcript.');
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
    throw new Error('Cannot identify Codex session. Pass --source.');

  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const matches = [];
  for (const directory of ['sessions', 'archived_sessions'])
    await searchTranscripts(join(home, directory), session, matches);

  if (matches.length !== 1)
    throw new Error('Cannot identify one Codex transcript. Pass --source.');

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

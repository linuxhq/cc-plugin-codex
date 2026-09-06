import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { sensitive } from './repository-policy.mjs';
import { runProcess } from './process.mjs';

export const writeTool = {
  name: 'write',
  description:
    'Create or replace a repository text file with a durable ' +
    'backup. Supply its exact current text as expected, or null for a new ' +
    'file. No shell execution. Parent directories must already exist.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'expected', 'content'],
    properties: {
      path: { type: 'string' },
      expected: { type: ['string', 'null'] },
      content: { type: 'string' },
    },
  },
};

export async function writeRepository(repo, recovery, input) {
  validate(input);
  repo = await realpath(repo);
  const path = await writablePath(repo, input.path);
  const before = await original(path);
  if (before.text !== input.expected)
    throw new Error('File changed; read its current content before editing.');
  await backup(recovery, input.path, before);
  const temporary = join(dirname(path), `.claude-write-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', before.mode || 0o600);
    try {
      await file.writeFile(input.content);
      await file.sync();
    } finally {
      await file.close();
    }
    await writablePath(repo, input.path);
    if ((await original(path)).text !== before.text)
      throw new Error('File changed during editing; write cancelled.');
    // Replace the directory entry, never follow an existing hard link.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return `Saved ${input.path}. Original content is in job backups.`;
}

function validate(input) {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !Object.hasOwn(writeTool.inputSchema.properties, key),
    ) ||
    typeof input.content !== 'string' ||
    !(input.expected === null || typeof input.expected === 'string')
  )
    throw new Error('Invalid write arguments.');
  if (
    [input.content, input.expected || ''].some(
      (text) =>
        text.includes('\0') || Buffer.byteLength(text) > 8 * 1024 * 1024,
    )
  )
    throw new Error('Only text files of at most 8 MiB may be edited.');
}

async function writablePath(repo, path) {
  validatePath(path);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const entry = join(repo, ...parts.slice(0, i));
    const info = await lstat(entry).catch((error) => {
      if (error.code === 'ENOENT' && i === parts.length) return null;
      throw error;
    });
    if (info?.isSymbolicLink() || (i < parts.length && !info?.isDirectory()))
      throw new Error('Symlinks and non-directory parents cannot be edited.');
  }
  const ignored = await runProcess(
    'git',
    ['check-ignore', '--no-index', '--', path],
    { cwd: repo },
  );
  if (ignored.code !== 1)
    throw new Error('Ignored or inaccessible write path.');
  return resolve(repo, path);
}

async function original(path) {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null, mode: null };
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024)
      throw new Error('Only regular files of at most 8 MiB may be edited.');
    const bytes = await file.readFile();
    const text = bytes.toString('utf8');
    if (text.includes('\0') || !Buffer.from(text).equals(bytes))
      throw new Error('Only UTF-8 text files may be edited.');
    return { text, mode: info.mode & 0o777 };
  } finally {
    await file.close();
  }
}

async function backup(recovery, path, before) {
  if (!recovery) throw new Error('Write recovery record is missing.');
  const record = JSON.parse(await readFile(recovery, 'utf8'));
  const lock = JSON.parse(await readFile(record.lock, 'utf8'));
  if (lock.token !== record.token)
    throw new Error('Write lock ownership lost.');
  const directory = join(dirname(recovery), 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(path).digest('hex') + '.json';
  const target = join(directory, name);
  try {
    await readFile(target);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ path, ...before }));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, target);
  const dir = await open(directory, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

function validatePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    sensitive.test(path)
  )
    throw new Error('Invalid or sensitive write path.');
}

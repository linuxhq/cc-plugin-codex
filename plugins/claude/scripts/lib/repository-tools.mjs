import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { git, repositoryRoot } from './git.mjs';
import { inspectionPage } from './inspection-page.mjs';

export const inspectionTool = {
  name: 'inspect',
  description:
    'Read-only repository inspection: files, paged reads, status, ' +
    'staged/unstaged or base...HEAD diffs, and recent history. ' +
    'Report unavailable evidence as a review limitation.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operation'],
    properties: {
      operation: {
        type: 'string',
        enum: ['files', 'read', 'status', 'diff', 'log'],
      },
      path: {
        type: 'string',
        description:
          'Literal repository-relative file path; optional diff filter.',
      },
      base: { type: 'string', description: 'Base ref for branch diff.' },
      staged: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
      byteOffset: {
        type: 'integer',
        minimum: 0,
        description:
          'Byte position within the offset line; use the returned ' +
          'next byteOffset to continue long lines. Not valid for files.',
      },
    },
  },
};

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid arguments.');

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(inspectionTool.inputSchema.properties, key))
      throw new Error('Unknown argument.');
  }

  validatePage(input);
  if (input.path !== undefined) validatePath(input.path);

  if (
    input.base !== undefined &&
    (typeof input.base !== 'string' || input.base.includes('\0'))
  )
    throw new Error('Invalid base.');

  if (input.staged !== undefined && typeof input.staged !== 'boolean')
    throw new Error('Invalid staged flag.');
}

function validatePage(input) {
  const { offset = 0, limit = 500, byteOffset = 0 } = input;
  validateByteOffset(input.operation, byteOffset);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000
  )
    throw new Error('Invalid page bounds.');
}

export async function inspectRepository(repo, input, options = {}) {
  validateInput(input);
  repo = await realpath(repo);
  const page = inspectionPage(input, options);
  if (input.operation === 'files') return listFiles(repo, input, options);

  if (input.operation === 'read')
    await readRepositoryFile(repo, input.path, page);
  else if (input.operation === 'diff') await diff(repo, input, page);
  else if (input.operation === 'status')
    await streamGit(repo, ['status', '--short', '--untracked-files=all'], page);
  else if (input.operation === 'log')
    await streamGit(
      repo,
      ['log', '--no-show-signature', '--no-decorate', '--oneline', '-50', '--'],
      page,
    );
  else throw new Error('Unknown inspection operation.');

  return page.finish();
}

function validatePath(file) {
  if (
    typeof file !== 'string' ||
    !file ||
    file.includes('\0') ||
    isAbsolute(file) ||
    file.split('/').includes('..')
  )
    throw new Error('Invalid repository-relative path.');
}

async function streamGit(repo, args, page) {
  await git(repo, args, { captureStdout: false, onStdout: page.write });
}

async function listFiles(repo, input, options) {
  const page = inspectionPage(input, {
    ...options,
    separator: '\0',
    render: (file) => JSON.stringify(file),
  });
  try {
    await repositoryRoot(repo);
  } catch {
    await listDirectory(repo, repo, input.path, page);
    return page.finish();
  }

  await streamGit(
    repo,
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--deduplicate',
      '-z',
      '--',
      ...(input.path ? [`:(literal)${input.path}`] : []),
    ],
    page,
  );
  return page.finish();
}

async function listDirectory(root, directory, filter, page) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const file = relative(root, path);
    if (entry.isDirectory()) await listDirectory(root, path, filter, page);
    else if (!filter || file === filter || file.startsWith(`${filter}/`))
      page.write(`${file}\0`);
  }
}

async function readRepositoryFile(repo, file, page) {
  validatePath(file);
  const path = await realpath(resolve(repo, file));
  if (!inside(repo, path)) throw new Error('File escapes repository.');

  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Not a regular file.');

    const stream = handle.createReadStream({
      encoding: 'utf8',
      autoClose: false,
    });
    for await (const chunk of stream) {
      if (chunk.includes('\0')) throw new Error('Binary file; not reviewed.');

      page.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

async function diff(repo, input, page) {
  const args = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--submodule=diff',
  ];
  if (input.base) {
    const revision = (
      await git(repo, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${input.base}^{commit}`,
      ])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision))
      throw new Error('Invalid resolved revision.');

    args.push(`${revision}...HEAD`);
  } else if (input.staged) args.push('--cached');

  return streamGit(
    repo,
    [...args, '--', input.path ? `:(literal)${input.path}` : '.'],
    page,
  );
}

function validateByteOffset(operation, byteOffset) {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    (operation === 'files' && byteOffset !== 0)
  )
    throw new Error('Invalid byte offset.');
}

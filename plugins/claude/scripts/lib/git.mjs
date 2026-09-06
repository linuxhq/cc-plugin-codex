import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process.mjs';

const maxContextBytes = 1024 * 1024;

export async function git(cwd, args) {
  const result = await runProcess('git', ['--no-pager', ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBytes: maxContextBytes * 2,
  });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || 'Git command failed.');
  return result.stdout;
}

export async function repositoryRoot(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trimEnd();
}

export function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function collectReview(repo, options) {
  const scope = options.base ? 'branch' : 'working-tree';
  const context =
    scope === 'branch'
      ? await branchContext(repo, options.base)
      : await workingContext(repo);
  if (Buffer.byteLength(context) > maxContextBytes) {
    throw new Error(
      'Review exceeds 1 MiB. Split the changes into smaller reviews. ' +
        'Nothing was sent to Claude.',
    );
  }
  return {
    scope,
    base: options.base,
    context,
    fingerprint: fingerprint(context),
  };
}

const diffFlags = [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--full-index',
  '--unified=5',
];

async function branchContext(repo, base) {
  const revision = (
    await git(repo, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${base}^{commit}`,
    ])
  ).trim();
  const mergeBase = (await git(repo, ['merge-base', revision, 'HEAD'])).trim();
  // File-reading tools must see the same tracked contents as the branch diff.
  const dirty = await git(repo, [
    'status',
    '--porcelain=v1',
    '--untracked-files=no',
  ]);
  if (dirty)
    throw new Error(
      'Branch review requires a clean tracked working tree. ' +
        'Commit or stash changes first.',
    );
  return git(repo, [...diffFlags, `${mergeBase}...HEAD`, '--']);
}

async function workingContext(repo) {
  const staged = await git(repo, [...diffFlags, '--cached', '--']);
  const unstaged = await git(repo, [...diffFlags, '--']);
  const files = (
    await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  const sections = [];
  if (staged) sections.push(`STAGED CHANGES (index)\n${staged}`);
  if (unstaged)
    sections.push(`UNSTAGED CHANGES (relative to index)\n${unstaged}`);
  for (const file of files) {
    sections.push(await untrackedFile(repo, file));
    if (Buffer.byteLength(sections.join('\n')) > maxContextBytes) {
      throw new Error(
        'Review exceeds 1 MiB. Split the changes into smaller reviews.',
      );
    }
  }
  return sections.join('\n');
}

async function untrackedFile(repo, file) {
  const path = join(repo, file);
  const stat = await lstat(path);
  const label = `UNTRACKED FILE ${JSON.stringify(file)}`;
  if (stat.isSymbolicLink())
    return `${label}\nSymlink target: ${await readlink(path)}\n`;
  if (!stat.isFile())
    return `${label}\nNon-regular file; contents not reviewed.\n`;
  if (stat.size > maxContextBytes)
    throw new Error(`Untracked file is too large: ${file}`);
  const content = await readFile(path);
  if (content.includes(0)) {
    return [
      label,
      'Binary file; contents not reviewed.',
      `SHA-256: ${fingerprint(content)}`,
      '',
    ].join('\n');
  }
  return `${label}\n${content.toString('utf8')}\n`;
}

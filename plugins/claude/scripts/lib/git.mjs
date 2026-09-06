import { createHash } from 'node:crypto';
import { lstat, open, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process.mjs';
import { collectContext } from './context.mjs';

const maxContextBytes = 1024 * 1024;

export async function git(cwd, args, options = {}) {
  const result = await runProcess('git', ['--no-pager', ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBytes: maxContextBytes * 2,
    ...options,
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
  const { scope, base } = await resolveReviewTarget(repo, options);
  const captured = await collectContext(
    (write) =>
      scope === 'branch'
        ? branchContext(repo, base, write)
        : workingContext(repo, write),
    options,
  );
  return {
    scope,
    base,
    ...captured,
  };
}

export async function resolveReviewTarget(repo, options) {
  if (options.base) return { scope: 'branch', base: options.base };
  if (options.scope === 'working-tree') return { scope: 'working-tree' };
  const dirty = await git(repo, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (options.scope !== 'branch' && dirty) return { scope: 'working-tree' };
  return { scope: 'branch', base: await detectDefaultBranch(repo) };
}

async function detectDefaultBranch(repo) {
  try {
    const ref = await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (ref.trim().startsWith('refs/remotes/origin/'))
      return ref.trim().replace('refs/remotes/origin/', '');
  } catch {
    // Repositories without an origin HEAD use the conventional branch names.
  }
  for (const name of ['main', 'master', 'trunk']) {
    for (const [prefix, base] of [
      ['refs/heads/', name],
      ['refs/remotes/origin/', `origin/${name}`],
    ]) {
      try {
        await git(repo, [
          'show-ref',
          '--verify',
          '--quiet',
          `${prefix}${name}`,
        ]);
        return base;
      } catch {
        // Try the next local or remote candidate.
      }
    }
  }
  throw new Error(
    'Unable to detect the repository default branch. ' +
      'Pass --base <ref> or use --scope working-tree.',
  );
}

const diffFlags = [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--full-index',
  '--unified=5',
];

async function branchContext(repo, base, write) {
  const revision = (
    await git(repo, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${base}^{commit}`,
    ])
  ).trim();
  const mergeBase = (await git(repo, ['merge-base', revision, 'HEAD'])).trim();
  await git(repo, [...diffFlags, `${mergeBase}...HEAD`, '--'], {
    captureStdout: false,
    onStdout: write,
  });
}

async function workingContext(repo, write) {
  await diffSection(
    repo,
    [...diffFlags, '--cached', '--'],
    'STAGED CHANGES (index)',
    write,
  );
  await diffSection(
    repo,
    [...diffFlags, '--'],
    'UNSTAGED CHANGES (relative to index)',
    write,
  );
  const files = (
    await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    await untrackedFile(repo, file, write);
  }
}

async function diffSection(repo, args, label, write) {
  let first = true;
  await git(repo, args, {
    captureStdout: false,
    onStdout(chunk) {
      if (first) write(`${label}\n`);
      first = false;
      write(chunk);
    },
  });
  if (!first) write('\n');
}

async function untrackedFile(repo, file, write) {
  const path = join(repo, file);
  const stat = await lstat(path);
  write(`UNTRACKED FILE ${JSON.stringify(file)}\n`);
  if (stat.isSymbolicLink())
    return write(`Symlink target: ${await readlink(path)}\n`);
  if (!stat.isFile())
    return write('Non-regular file; contents not reviewed.\n');
  const handle = await open(path, 'r');
  try {
    let binary = false;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      binary ||= chunk.includes(0);
      hash.update(chunk);
    }
    if (binary) {
      write('Binary file; contents not reviewed.\n');
      write(`SHA-256: ${hash.digest('hex')}`);
    } else {
      const stream = handle.createReadStream({ start: 0, autoClose: false });
      for await (const chunk of stream) write(chunk);
    }
    write('\n');
  } finally {
    await handle.close();
  }
}

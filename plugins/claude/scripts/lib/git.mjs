import { sensitive, secretExclusions } from './repository-policy.mjs';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process.mjs';

const maxContextBytes = 1024 * 1024;

export async function git(cwd, args, options = {}) {
  const result = await runProcess(
    'git',
    ['--no-pager', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBytes: maxContextBytes * 2,
      ...options,
    },
  );
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

export async function collectReview(repo, options = {}) {
  const target = await resolveReviewTarget(repo, options);
  if (options.command === 'review')
    return {
      ...target,
      context:
        'Inspect the target diff using the repository inspect tool ' +
        '(diff operation).',
      inputMode: 'self-collect',
    };
  const details =
    target.scope === 'branch'
      ? await branchContext(repo, target.base)
      : await workingContext(repo);
  return {
    ...target,
    ...details,
    collectionGuidance:
      details.inputMode === 'inline-diff'
        ? 'Use the repository context below as primary evidence.'
        : 'The repository context below is a lightweight summary. ' +
          'Use the repository inspect tool: diff for changes, files/read for ' +
          'surrounding code, and status/log for context before findings.',
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
  '--binary',
  '--submodule=diff',
];
const inlineBytes = 256 * 1024;

async function diffContext(repo, sections, files) {
  const parts = [];
  let bytes = 0;
  if (files.length <= 2) {
    for (const [label, args] of sections) {
      parts.push(`${label}\n`);
      await git(repo, [...diffFlags, ...args, '--', ...secretExclusions], {
        captureStdout: false,
        onStdout(chunk) {
          bytes += Buffer.byteLength(chunk);
          if (bytes <= inlineBytes) parts.push(chunk);
        },
      });
    }
    if (bytes <= inlineBytes)
      return { context: parts.join(''), inputMode: 'inline-diff' };
  }
  const stats = [];
  for (const [label, args] of sections) {
    stats.push(
      label,
      await git(repo, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--stat',
        ...args,
        '--',
      ]),
    );
  }
  return {
    context: [
      ...stats,
      'Changed Files',
      ...files.map((file) => JSON.stringify(file)),
    ].join('\n'),
    inputMode: 'self-collect',
  };
}

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
  const range = `${mergeBase}..HEAD`;
  const files = (await git(repo, ['diff', '--name-only', '-z', range, '--']))
    .split('\0')
    .filter(Boolean);
  const details = await diffContext(repo, [['Branch Diff', [range]]], files);
  const log = await git(repo, ['log', '--oneline', range, '--']);
  return { ...details, context: `Commit Log\n${log}\n${details.context}` };
}

async function workingContext(repo) {
  const untracked = (
    await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  const staged = await git(repo, ['diff', '--cached', '--name-only', '-z']);
  const unstaged = await git(repo, ['diff', '--name-only', '-z']);
  const files = [
    ...new Set(
      [...staged.split('\0'), ...unstaged.split('\0'), ...untracked].filter(
        Boolean,
      ),
    ),
  ];
  const details = await diffContext(
    repo,
    [
      ['STAGED CHANGES (index)', ['--cached']],
      ['UNSTAGED CHANGES (relative to index)', []],
    ],
    files,
  );
  const status = await git(repo, [
    'status',
    '--short',
    '--untracked-files=all',
  ]);
  const contents = await Promise.all(
    untracked.map((file) => untrackedFile(repo, file)),
  );
  return {
    ...details,
    context: [status, details.context, ...contents].join('\n'),
  };
}

async function untrackedFile(repo, file) {
  if (sensitive.test(file)) return 'Sensitive untracked file omitted.';
  const path = join(repo, file);
  const title = `UNTRACKED FILE ${JSON.stringify(file)}\n`;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      return title + `Symlink target: ${await readlink(path)}`;
    if (!info.isFile())
      return title + 'Non-regular file; contents not reviewed.';
    if (info.size > 24 * 1024)
      return title + '(skipped: exceeds 24576 byte limit)';
    const data = await readFile(path);
    return (
      title +
      (data.includes(0)
        ? 'Binary file; contents not reviewed.'
        : data.toString('utf8'))
    );
  } catch {
    return title + '(skipped: unreadable file)';
  }
}

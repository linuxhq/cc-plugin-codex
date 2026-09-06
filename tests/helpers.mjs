import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';

export const cli = fileURLToPath(
  new URL('../plugins/claude/scripts/claude-review.mjs', import.meta.url),
);

export async function fixture(t, { commit = true } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'claude-review-test-')),
  );
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups) await cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const repo = join(root, 'repo with spaces');
  const bin = join(root, 'bin');
  await mkdir(repo);
  await mkdir(bin);
  const fake = fileURLToPath(new URL('./fixtures/claude.mjs', import.meta.url));
  const launcher = `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`;
  await writeFile(join(bin, 'claude'), launcher, { mode: 0o700 });
  const env = {
    ...process.env,
    CODEX_THREAD_ID: 'test-session',
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    CLAUDE_REVIEW_DATA_DIR: join(root, 'data'),
    FAKE_CLAUDE_CAPTURE: join(root, 'request.json'),
  };
  const git = async (...args) => {
    const result = await runProcess('git', args, { cwd: repo, env });
    if (result.code) throw new Error(result.stderr);
    return result.stdout;
  };
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Review Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', '/dev/null');
  const write = (name, contents) => writeFile(join(repo, name), contents);
  await write('app.js', 'export const value = 1;\n');
  if (commit) {
    await git('add', '.');
    await git('commit', '-m', 'Initial');
  }
  const run = (args, overrides = {}) =>
    runProcess(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...env, ...overrides },
    });
  const cleanup = (callback) => cleanups.push(callback);
  return { root, repo, env, git, write, run, cleanup };
}

export async function eventually(check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for test worker.');
}

export function extractId(output) {
  const match = /review-[a-f0-9-]{36}/.exec(output);
  if (!match) throw new Error(`No job ID in output: ${output}`);
  return match[0];
}

import assert from 'node:assert/strict';
import { access, readFile, utimes, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { fingerprint } from '../plugins/claude/scripts/lib/git.mjs';
import { fixture, eventually, cli } from './helpers.mjs';
import {
  createJob,
  saveJob,
  listJobs,
  pruneJobs,
  jobPath,
} from '../plugins/claude/scripts/lib/store.mjs';

const hook = fileURLToPath(
  new URL(
    '../plugins/claude/scripts/session-lifecycle-hook.mjs',
    import.meta.url,
  ),
);

for (const failure of ['ENOENT', 'EISDIR']) {
  test(`cleanup continues after ${failure}`, async (t) => {
    const f = await fixture(t);
    const root = join(
      f.env.CLAUDE_REVIEW_DATA_DIR,
      'jobs',
      fingerprint(f.repo).slice(0, 24),
    );
    const remaining = await createJob(root, {
      repo: f.repo,
      sessionId: 'test-session',
    });
    await saveJob(root, { ...remaining, createdAt: new Date(0).toISOString() });
    const failing = await createJob(root, {
      repo: f.repo,
      sessionId: 'test-session',
    });
    const preload = join(f.root, 'race.mjs');
    const marker = jobPath(root, failing.id, 'session-ended');
    const directory = jobPath(root, failing.id, '.');
    const remove =
      failure === 'ENOENT'
        ? `await fs.rm(${JSON.stringify(directory)}, options);`
        : '';
    await writeFile(
      preload,
      `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFile;
      const options = { recursive: true, force: true };
      fs.writeFile = async (path, ...args) => {
        if (path === ${JSON.stringify(marker)}) {
          ${remove}
        }
        return write(path, ...args);
      };
      syncBuiltinESMExports();
    `,
    );
    if (failure === 'EISDIR')
      await mkdir(jobPath(root, failing.id, 'session-ended'));

    const run = await runProcess(
      process.execPath,
      ['--import', preload, hook, 'SessionEnd'],
      {
        cwd: f.repo,
        env: f.env,
        input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
      },
    );
    assert.equal(run.code, failure === 'ENOENT' ? 0 : 1, run.stderr);
    await access(jobPath(root, remaining.id, 'session-ended'));
    await access(jobPath(root, remaining.id, 'cancel'));
  });
}

test('session end removes records of workers that exited', async (t) => {
  const f = await fixture(t);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  const job = await createJob(root, {
    repo: f.repo,
    sessionId: 'test-session',
  });
  const worker = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => worker.once('exit', resolve));
  await writeFile(jobPath(root, job.id, 'worker-pid'), String(worker.pid));
  const run = await runProcess(process.execPath, [hook, 'SessionEnd'], {
    cwd: f.repo,
    env: f.env,
    input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
  });
  assert.equal(run.code, 0, run.stderr);
  await assert.rejects(access(jobPath(root, job.id)), { code: 'ENOENT' });
});

test('paused workers survive pruning and finish session cleanup', async (t) => {
  const f = await fixture(t);
  const worker = spawn(process.execPath, [cli, 'rescue', 'inspect'], {
    cwd: f.repo,
    env: { ...f.env, FAKE_CLAUDE_MODE: 'slow' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  worker.stdout.on('data', (chunk) => {
    output += chunk;
  });
  worker.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => worker.once('close', resolve));
  f.cleanup(async () => {
    worker.kill('SIGCONT');
    worker.kill('SIGTERM');
    await exited;
  });
  await eventually(async () => {
    try {
      return Boolean(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
    } catch (error) {
      if (error.code === 'ENOENT') return false;

      throw error;
    }
  });
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  const [job] = await listJobs(root);
  worker.kill('SIGSTOP');
  const past = new Date(Date.now() - 60_000);
  await utimes(jobPath(root, job.id, 'heartbeat'), past, past);
  const finished = await createJob(root, { repo: f.repo });
  await saveJob(root, { ...finished, state: 'completed' });
  await pruneJobs(root, { maxCount: 1 });
  await access(jobPath(root, job.id));
  const run = await runProcess(process.execPath, [hook, 'SessionEnd'], {
    cwd: f.repo,
    env: f.env,
    input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
  });
  assert.equal(run.code, 0, run.stderr);
  await access(jobPath(root, job.id));
  await access(jobPath(root, job.id, 'cancel'));
  worker.kill('SIGCONT');
  await exited;
  await assert.rejects(
    access(jobPath(root, job.id)),
    { code: 'ENOENT' },
    output,
  );
});

test('session end cleans up its own jobs', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const finished = JSON.parse(
    (await f.run(['rescue', '--json', 'inspect'])).stdout,
  ).job;
  const foreign = JSON.parse(
    (
      await f.run(['rescue', '--json', 'inspect'], {
        CODEX_THREAD_ID: 'other-session',
      })
    ).stdout,
  ).job;
  const running = JSON.parse(
    (
      await f.run(['rescue', '--background', '--json', 'inspect'], {
        FAKE_CLAUDE_MODE: 'slow',
      })
    ).stdout,
  ).job;
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  f.cleanup(async () => {
    await f.run(['cancel', running.id]);
  });
  await eventually(async () => {
    const report = JSON.parse(
      (await f.run(['status', running.id, '--json'])).stdout,
    );
    return (
      report.job.progress.summary === 'Using Read.' &&
      Boolean(report.job.claudeSessionId)
    );
  });
  const run = await runProcess(process.execPath, [hook, 'SessionEnd'], {
    cwd: f.repo,
    env: { ...f.env, CODEX_THREAD_ID: 'other-session' },
    input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
  });
  assert.equal(run.code, 0, run.stderr);
  await assert.rejects(access(join(root, finished.id)), { code: 'ENOENT' });
  await eventually(async () => {
    try {
      await access(join(root, running.id));
      return false;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  });
  await access(join(root, foreign.id, 'job.json'));
  assert.equal(
    JSON.parse(await readFile(join(root, 'gate.json'))).enabled,
    true,
  );
});

test('unrelated lifecycle events leave records intact', async (t) => {
  const f = await fixture(t);
  const finished = JSON.parse(
    (await f.run(['rescue', '--json', 'inspect'])).stdout,
  ).job;
  const run = await runProcess(process.execPath, [hook], {
    cwd: f.repo,
    env: f.env,
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'test-session',
    }),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal((await f.run(['result', finished.id])).code, 0);
});

test('session end requests cancellation for stale workers', async (t) => {
  const f = await fixture(t);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  const job = await createJob(root, {
    repo: f.repo,
    sessionId: 'test-session',
  });
  await saveJob(root, { ...job, createdAt: new Date(0).toISOString() });
  const run = await runProcess(process.execPath, [hook, 'SessionEnd'], {
    cwd: f.repo,
    env: f.env,
    input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
  });
  assert.equal(run.code, 0, run.stderr);
  await access(join(root, job.id, 'job.json'));
  await access(join(root, job.id, 'session-ended'));
  await access(join(root, job.id, 'cancel'));
});

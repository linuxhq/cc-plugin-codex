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
  jobPath,
  pruneJobs,
} from '../plugins/claude/scripts/lib/store.mjs';

const hook = fileURLToPath(
  new URL(
    '../plugins/claude/scripts/session-lifecycle-hook.mjs',
    import.meta.url,
  ),
);

test('standalone cleanup survives slow runner startup', async (t) => {
  const f = await fixture(t);
  const activity = join(f.root, 'standalone-helper.json');
  let pid = null;
  f.cleanup(async () => {
    if (!pid) return;

    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
  const preload = join(f.root, 'slow-runner.mjs');
  await writeFile(
    preload,
    `
    if (process.argv[1]?.endsWith('/process-runner.mjs'))
      await new Promise((resolve) => setTimeout(resolve, 300));
  `,
  );
  const response = await f.run(['rescue', '--write', '--json', 'inspect'], {
    CODEX_THREAD_ID: '',
    FAKE_CLAUDE_HELPER_ACTIVITY: activity,
    FAKE_CLAUDE_HELPER_STDIO: 'both',
    NODE_OPTIONS: `--import=${preload}`,
  });
  pid = JSON.parse(await readFile(activity)).pid;
  assert.equal(response.code, 0, response.stdout + response.stderr);
  assert.match(JSON.parse(response.stdout).output, /Example finding/);
  await eventually(async () => {
    const before = await readFile(activity, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    return before === (await readFile(activity, 'utf8'));
  });
});

for (const pruned of [false, true]) {
  test(`session end cleans helpers; pruned=${pruned}`, async (t) => {
    const f = await fixture(t);
    const root = join(
      f.env.CLAUDE_REVIEW_DATA_DIR,
      'jobs',
      fingerprint(f.repo).slice(0, 24),
    );
    const helpers = [];
    f.cleanup(async () => {
      for (const target of helpers.flatMap(({ pid, guardian }) => [
        pid,
        guardian,
      ])) {
        try {
          process.kill(target, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
    for (const session of ['test-session', 'other-session']) {
      const activity = join(f.root, `${session}.json`);
      const response = await f.run(['rescue', '--write', '--json', 'inspect'], {
        CODEX_THREAD_ID: session,
        FAKE_CLAUDE_HELPER_ACTIVITY: activity,
        FAKE_CLAUDE_HELPER_STDIO: pruned ? 'stderr' : 'stdout',
        FAKE_CLAUDE_MODE: session === 'test-session' ? '' : 'fail',
      });
      assert.equal(
        response.code,
        session === 'test-session' ? 0 : 1,
        response.stdout + response.stderr,
      );
      const { job } = JSON.parse(response.stdout);
      assert.equal(
        job.state,
        session === 'test-session' ? 'completed' : 'failed',
      );
      const pid = await eventually(async () => {
        try {
          return JSON.parse(await readFile(activity)).pid;
        } catch (error) {
          if (error.code === 'ENOENT') return false;

          throw error;
        }
      });
      const guardian = Number(
        await readFile(jobPath(root, job.id, 'helper-pid')),
      );
      helpers.push({ id: job.id, pid, guardian, activity });
    }

    if (pruned) await pruneJobs(root, { maxCount: 0 });

    for (const helper of helpers) {
      const before = await readFile(helper.activity, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.notEqual(await readFile(helper.activity, 'utf8'), before);
      await access(jobPath(root, helper.id, 'session-id'));
    }

    const ended = await runProcess(process.execPath, [hook, 'SessionEnd'], {
      cwd: f.repo,
      env: f.env,
      input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
    });
    assert.equal(ended.code, 0, ended.stderr);
    await eventually(async () => {
      const before = await readFile(helpers[0].activity, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      return before === (await readFile(helpers[0].activity, 'utf8'));
    });
    const before = await readFile(helpers[1].activity, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.notEqual(await readFile(helpers[1].activity, 'utf8'), before);
    await writeFile(helpers[1].activity + '.stop', '');
    await eventually(async () => {
      try {
        await access(jobPath(root, helpers[1].id, 'helper-pid'));
        return false;
      } catch (error) {
        if (error.code === 'ENOENT') return true;

        throw error;
      }
    });
  });
}

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

test('paused workers stop after session end', async (t) => {
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
  await access(jobPath(root, job.id));
  const resume = await f.run(['rescue', '--resume', 'continue']);
  assert.equal(resume.code, 1);
  assert.match(resume.stderr, /still running/);
  const cancel = await f.run(['cancel', job.id]);
  assert.equal(cancel.code, 0, cancel.stderr);
  await access(jobPath(root, job.id, 'cancel'));
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
  const { pid } = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  await eventually(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;

      throw error;
    }
  });
  await assert.rejects(
    access(jobPath(root, job.id)),
    { code: 'ENOENT' },
    output,
  );
});

test('session end cancels only its own pruned workers', async (t) => {
  const f = await fixture(t);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  const jobs = [];
  const endSession = (sessionId) =>
    runProcess(process.execPath, [hook, 'SessionEnd'], {
      cwd: f.repo,
      env: f.env,
      input: JSON.stringify({ cwd: f.repo, session_id: sessionId }),
    });
  f.cleanup(async () => {
    for (const job of jobs) await endSession(job.sessionId);

    await eventually(async () => {
      const entries = await Promise.all(
        jobs.map((job) =>
          access(jobPath(root, job.id, '.')).then(
            () => true,
            (error) => {
              if (error.code === 'ENOENT') return false;

              throw error;
            },
          ),
        ),
      );
      return entries.every((entry) => !entry);
    });
  });
  for (const sessionId of ['test-session', 'other-session']) {
    const job = JSON.parse(
      (
        await f.run(
          ['rescue', '--write', '--background', '--json', 'inspect'],
          {
            CODEX_THREAD_ID: sessionId,
            FAKE_CLAUDE_MODE: 'held',
            FAKE_CLAUDE_RELEASE: join(f.root, 'release'),
          },
        )
      ).stdout,
    ).job;
    jobs.push(job);
    await eventually(async () => {
      const report = JSON.parse(
        (await f.run(['status', job.id, '--json'])).stdout,
      );
      return (
        report.job.claudeSessionId &&
        report.job.progress.summary === 'Using Read.'
      );
    });
  }

  await pruneJobs(root, { maxCount: 0 });
  assert.deepEqual(await listJobs(root), []);
  const end = await endSession('test-session');
  assert.equal(end.code, 0, end.stderr);
  await eventually(async () => {
    try {
      await access(jobPath(root, jobs[0].id, '.'));
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;

      throw error;
    }
  });
  await assert.rejects(access(jobPath(root, jobs[0].id)), { code: 'ENOENT' });
  await access(jobPath(root, jobs[1].id, '.'));
  await assert.rejects(access(jobPath(root, jobs[1].id, 'cancel')), {
    code: 'ENOENT',
  });
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
  await access(jobPath(root, foreign.id));
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
  await access(jobPath(root, job.id));
  await access(join(root, job.id, 'session-ended'));
  await access(join(root, job.id, 'cancel'));
});

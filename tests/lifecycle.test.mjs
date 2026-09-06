import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { fingerprint } from '../plugins/claude/scripts/lib/git.mjs';
import { fixture, eventually } from './helpers.mjs';
import { createJob, saveJob } from '../plugins/claude/scripts/lib/store.mjs';

const hook = fileURLToPath(
  new URL(
    '../plugins/claude/scripts/session-lifecycle-hook.mjs',
    import.meta.url,
  ),
);

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

test('session end removes interrupted workers too', async (t) => {
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
  await assert.rejects(access(join(root, job.id)), { code: 'ENOENT' });
});

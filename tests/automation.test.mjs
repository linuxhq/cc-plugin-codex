import assert from 'node:assert/strict';
import { mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, eventually } from './helpers.mjs';
import { fingerprint } from '../plugins/claude/scripts/lib/git.mjs';
import {
  createJob,
  saveJob,
  jobPath,
} from '../plugins/claude/scripts/lib/store.mjs';
import {
  saveProgress,
  formatProgress,
  updateProgress,
} from '../plugins/claude/scripts/lib/progress.mjs';

const rootFor = (f) =>
  join(f.env.CLAUDE_REVIEW_DATA_DIR, 'jobs', fingerprint(f.repo).slice(0, 24));

test('session scope uses only CODEX_THREAD_ID', async (t) => {
  const f = await fixture(t);
  for (const thread of ['current-thread', '']) {
    const run = await f.run(['status', '--json'], {
      CODEX_THREAD_ID: thread,
      CODEX_SESSION_ID: 'alternate-session',
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).sessionId, thread || null);
  }
});

test('result explains when an explicit job is still active', async (t) => {
  const f = await fixture(t);
  const job = await createJob(rootFor(f), {
    repo: f.repo,
    command: 'rescue',
    sessionId: 'other-session',
  });
  for (const reference of [job.id, job.id.slice(0, 15)]) {
    const run = await f.run(['result', reference]);
    assert.equal(run.code, 1);
    assert.ok(run.stderr.includes(`Job ${job.id} is still queued.`));
    assert.match(run.stderr, /Check \$claude:status/);
    assert.doesNotMatch(run.stderr, /not found/);
  }
});

test('status duration follows upstream rounding and units', () => {
  const createdAt = '2026-09-06T00:00:00.000Z';
  for (const [milliseconds, expected] of [
    [600, '1s'],
    [61_000, '1m 1s'],
    [3_661_000, '1h 1m'],
  ]) {
    const finishedAt = new Date(
      Date.parse(createdAt) + milliseconds,
    ).toISOString();
    const output = formatProgress(
      {
        createdAt,
        finishedAt,
      },
      'completed',
      {},
    );
    assert.ok(output.includes(`Duration: ${expected}  Phase: done`), output);
  }

  assert.doesNotMatch(
    formatProgress({ createdAt: 'invalid' }, 'running', {}),
    /Elapsed:|NaN/,
  );
});

test('progress messages retain the last known phase and session', () => {
  const progress = updateProgress(
    { phase: 'verifying', claudeSessionId: 'session' },
    { summary: 'Still working' },
  );
  assert.equal(progress.phase, 'verifying');
  assert.equal(progress.claudeSessionId, 'session');
});

test('JSON preserves results and honors cwd and model aliases', async (t) => {
  const f = await fixture(t);
  const nested = join(f.repo, 'nested folder');
  await mkdir(nested);
  await f.write('app.js', 'changed\n');
  const run = await f.run([
    'review',
    '--wait',
    '--json',
    '-C',
    nested,
    '-m',
    'provider/model',
  ]);
  assert.equal(run.code, 0, run.stderr);
  const review = JSON.parse(run.stdout);
  assert.equal(review.job.state, 'completed');
  assert.equal(review.job.repo, f.repo);
  assert.equal(review.job.model, 'provider/model');
  assert.equal(review.failed, false);
  assert.equal(review.job.prompt, undefined);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.equal(request.cwd, f.repo);
  const plain = await f.run(['result', review.job.id]);
  assert.equal(plain.stdout, `${review.output}\n`);
  const result = await f.run(['result', review.job.id.slice(0, 16), '--json']);
  assert.equal(JSON.parse(result.stdout).output, review.output);
  const adversarial = await f.run(['adversarial-review', '--wait', '--json']);
  assert.equal(adversarial.code, 0, adversarial.stderr);
  const structured = JSON.parse(adversarial.stdout).job.structuredOutput;
  assert.equal(structured.verdict, 'needs-attention');
  assert.equal(structured.findings[0].confidence, 0.9);
});

test('result and cancel respect session scope', async (t) => {
  const f = await fixture(t);
  const root = rootFor(f);
  async function job(sessionId, state, updatedAt) {
    const value = await createJob(root, {
      repo: f.repo,
      command: 'review',
      sessionId,
    });
    await saveJob(root, {
      ...value,
      state,
      updatedAt,
      error: 'Stored failure',
    });
    return value;
  }
  const older = await job('test-session', 'failed', '2026-01-01T00:00:01Z');
  const finished = await job('test-session', 'failed', '2026-01-01T00:00:02Z');
  const running = await job('test-session', 'running');
  const other = await job('other-session', 'running');
  // A job created earlier but updated later should supply the default result.
  await saveProgress(root, older.id, { updatedAt: '2099-01-01T00:00:00Z' });
  const result = await f.run(['result', '--json']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).job.id, older.id);
  assert.equal(JSON.parse(result.stdout).failed, true);
  const cancel = await f.run(['cancel', '--json']);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).job.id, running.id);
  await access(jobPath(root, running.id, 'cancel'));
  await assert.rejects(access(jobPath(root, other.id, 'cancel')));
  const second = await job('test-session', 'queued');
  const ambiguous = await f.run(['cancel', '--json']);
  assert.equal(ambiguous.code, 1);
  assert.match(JSON.parse(ambiguous.stdout).error, /Multiple review jobs/);
  await assert.rejects(access(jobPath(root, second.id, 'cancel')));
  const explicit = await f.run(['cancel', other.id.slice(0, 16), '--json']);
  assert.equal(JSON.parse(explicit.stdout).job.id, other.id);
  const foreignResult = await f.run(['result', finished.id, '--json'], {
    CODEX_THREAD_ID: 'other-session',
  });
  assert.equal(JSON.parse(foreignResult.stdout).job.id, finished.id);
  for (const command of ['cancel', 'result']) {
    const empty = await f.run([command, '--json'], {
      CODEX_THREAD_ID: 'empty-session',
    });
    assert.equal(empty.code, 1);
    assert.match(JSON.parse(empty.stdout).error, /this session/);
  }
});

test('status orders and limits history by last activity', async (t) => {
  const f = await fixture(t);
  const root = rootFor(f);
  const jobs = [];
  for (let i = 0; i < 11; i++) {
    const job = await createJob(root, {
      repo: f.repo,
      command: 'review',
      sessionId: 'test-session',
    });
    await saveJob(root, { ...job, state: i < 2 ? 'running' : 'failed' });
    await saveProgress(root, job.id, {
      updatedAt: new Date(Date.UTC(2099, 0, 11 - i)).toISOString(),
    });
    jobs.push(job);
  }

  const report = JSON.parse((await f.run(['status', '--json'])).stdout);
  assert.deepEqual(
    report.running.map((job) => job.id),
    jobs.slice(0, 2).map((job) => job.id),
  );
  assert.equal(report.latestFinished.id, jobs[2].id);
  assert.deepEqual(
    report.recent.map((job) => job.id),
    jobs.slice(3, 8).map((job) => job.id),
  );
  const all = JSON.parse((await f.run(['status', '--all', '--json'])).stdout);
  assert.equal(all.recent.length, 8);
});

test('JSON handles setup, empty reviews, and errors', async (t) => {
  const f = await fixture(t);
  const ready = await f.run(['setup', '--json']);
  assert.equal(JSON.parse(ready.stdout).ready, true);
  const review = await f.run(['review', '--json']);
  assert.equal(JSON.parse(review.stdout).job.state, 'completed');
  for (const args of [
    ['status', '--wait', '--json'],
    ['review', '--cwd', '/no/such/path', '--json'],
    ['result', 'review-00000000-0000-0000-0000-000000000000', '--json'],
  ]) {
    const run = await f.run(args);
    assert.equal(run.code, 1);
    assert.equal(typeof JSON.parse(run.stdout).error, 'string');
  }

  await f.write('app.js', 'changed\n');
  const failed = await f.run(['review', '--json'], {
    FAKE_CLAUDE_MODE: 'json-error',
  });
  assert.equal(failed.code, 1);
  const payload = JSON.parse(failed.stdout);
  assert.equal(payload.job.state, 'failed');
  assert.equal(payload.failed, true);
  assert.match(payload.output, /Account quota exhausted/);
});

test('task workflows and gate settings work outside Git', async (t) => {
  const f = await fixture(t);
  const args = ['--cwd', f.root, '--json'];
  const setup = await f.run(['setup', '--enable-review-gate', ...args]);
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).gate.enabled, true);
  assert.equal(JSON.parse(setup.stdout).workspaceRoot, f.root);
  const rescue = await f.run(['rescue', ...args, 'inspect']);
  assert.equal(rescue.code, 0, rescue.stderr);
  const job = JSON.parse(rescue.stdout).job;
  const status = await f.run(['status', ...args]);
  assert.equal(JSON.parse(status.stdout).latestFinished.id, job.id);
  const result = await f.run(['result', ...args]);
  assert.equal(JSON.parse(result.stdout).job.id, job.id);
  const candidate = await f.run(['rescue-resume-candidate', ...args]);
  assert.equal(JSON.parse(candidate.stdout).jobId, job.id);
  assert.equal((await f.run(['review', ...args])).code, 1);
  assert.equal((await f.run(['adversarial-review', ...args])).code, 1);
});

test('status wait observes timeout and cancellation', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const launch = await f.run(['review', '--background', '--json'], {
    FAKE_CLAUDE_MODE: 'slow',
  });
  const id = JSON.parse(launch.stdout).job.id;
  f.cleanup(async () => {
    await f.run(['cancel', id]);
    await eventually(async () => {
      const status = await f.run(['status', id, '--json']);
      return JSON.parse(status.stdout).job.state === 'cancelled';
    });
  });
  const wait = await f.run([
    'status',
    id,
    '--wait',
    '--timeout-ms',
    '-1',
    '--json',
  ]);
  assert.equal(wait.code, 0);
  const timed = JSON.parse(wait.stdout);
  assert.equal(timed.waitTimedOut, true);
  assert.ok(['queued', 'running'].includes(timed.job.state));
  const cancel = await f.run(['cancel', id, '--json']);
  assert.ok(JSON.parse(cancel.stdout).message.includes(id));
  const finished = await f.run([
    'status',
    id,
    '--wait',
    '--timeout-ms',
    '5000',
    '--poll-interval-ms',
    '100',
    '--json',
  ]);
  const payload = JSON.parse(finished.stdout);
  assert.equal(payload.waitTimedOut, false);
  assert.equal(payload.job.state, 'cancelled');
});

test('status all expands history and escapes table cells', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) {
    const job = await createJob(rootFor(f), {
      repo: f.repo,
      command: 'review',
      sessionId: 'test-session',
      state: 'completed',
      progress: { summary: 'Text | with\nnewlines' },
    });
    await saveJob(rootFor(f), { ...job, state: 'completed' });
  }

  const other = await createJob(rootFor(f), {
    repo: f.repo,
    command: 'review',
    sessionId: 'other-session',
    state: 'completed',
  });
  const normal = JSON.parse((await f.run(['status', '--json'])).stdout);
  assert.equal(normal.recent.length, 7);
  const all = JSON.parse((await f.run(['status', '--all', '--json'])).stdout);
  assert.equal(all.recent.length, 10);
  assert.ok(!JSON.stringify(all).includes(other.id));
  const single = await f.run(['status', other.id, '--json']);
  assert.equal(JSON.parse(single.stdout).job.id, other.id);
  const table = (await f.run(['status'])).stdout;
  assert.match(table, /^\| Job \|/);
  assert.ok(table.includes('Text \\| with newlines'));
  assert.ok(table.includes('$claude:result'));
});

test('job prefixes filter by state', async (t) => {
  const f = await fixture(t);
  const root = rootFor(f);
  const finished = await createJob(root, { repo: f.repo, command: 'review' });
  await saveJob(root, {
    ...finished,
    state: 'failed',
    error: 'Stored failure',
  });
  const running = await createJob(root, { repo: f.repo, command: 'review' });
  const result = await f.run(['result', 'review-', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).job.id, finished.id);
  const cancel = await f.run(['cancel', 'review-', '--json']);
  assert.equal(cancel.code, 0, cancel.stdout);
  assert.equal(JSON.parse(cancel.stdout).job.id, running.id);
  assert.equal((await f.run(['status', 'review-'])).code, 1);
});

test('status includes settings and follow-up commands', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  assert.match((await f.run(['status'])).stdout, /enabled/);
  const job = JSON.parse(
    (await f.run(['rescue', '--write', '--json', 'fix'])).stdout,
  ).job;
  const table = (await f.run(['status'])).stdout;
  assert.ok(table.includes(job.claudeSessionId));
  const single = (await f.run(['status', job.id])).stdout;
  assert.ok(single.includes(`$claude:result ${job.id}`));
  assert.match(single, /\$claude:review --wait/);
  assert.match(single, /\$claude:adversarial-review --wait/);
  const queued = await createJob(rootFor(f), {
    repo: f.repo,
    command: 'review',
  });
  assert.ok(
    (await f.run(['status', queued.id])).stdout.includes(
      `$claude:cancel ${queued.id}`,
    ),
  );
});

test('finished status timing follows upstream coercion', async (t) => {
  const f = await fixture(t);
  const job = JSON.parse(
    (await f.run(['rescue', '--json', 'inspect'])).stdout,
  ).job;
  for (const [value, expected] of [
    ['0', 240000],
    ['NaN', 240000],
    ['-1', 0],
    ['1.5', 1.5],
  ]) {
    const run = await f.run([
      'status',
      job.id,
      '--wait',
      '--timeout-ms',
      value,
      '--poll-interval-ms',
      '1',
      '--json',
    ]);
    assert.equal(run.code, 0, run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.timeoutMs, expected);
    assert.equal(payload.waitTimedOut, false);
  }
});

test('finished status summarizes results and failures', async (t) => {
  const f = await fixture(t);
  const rescue = JSON.parse(
    (
      await f.run(['rescue', '--json', 'inspect'], {
        FAKE_CLAUDE_OUTPUT: '\nDiagnosis complete.\nMore detail.',
      })
    ).stdout,
  );
  assert.equal(rescue.job.progress.summary, 'Diagnosis complete.');
  assert.equal(rescue.job.progress.phase, 'done');
  assert.match((await f.run(['status', rescue.job.id])).stdout, /Phase: done/);
  const review = JSON.parse(
    (await f.run(['adversarial-review', '--json'])).stdout,
  );
  assert.equal(
    review.job.progress.summary,
    review.job.structuredOutput.summary,
  );
  const failed = JSON.parse(
    (
      await f.run(['review', '--json'], {
        FAKE_CLAUDE_MODE: 'fail',
      })
    ).stdout,
  );
  assert.equal(failed.job.progress.summary, 'Provider unavailable');
});

test('interrupted results retain continuation information', async (t) => {
  const f = await fixture(t);
  const root = rootFor(f);
  const job = await createJob(root, {
    repo: f.repo,
    command: 'rescue',
    sessionId: 'test-session',
  });
  await saveJob(root, { ...job, createdAt: new Date(0).toISOString() });
  const session = '12345678-1234-1234-1234-123456789abc';
  await saveProgress(root, job.id, { claudeSessionId: session });
  const run = await f.run(['result', job.id, '--json']);
  assert.equal(run.code, 0, run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.job.state, 'interrupted');
  assert.ok(payload.output.includes(`claude --resume ${session}`));
});

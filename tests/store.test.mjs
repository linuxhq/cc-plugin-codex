import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import {
  createJob,
  jobPath,
  jobState,
  loadJob,
  listJobs,
  pruneJobs,
  saveJob,
  storeRoot,
} from '../plugins/claude/scripts/lib/store.mjs';
import { fixture } from './helpers.mjs';

test('retention preserves stale workers and the latest result', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const stale = await createJob(root, { repo: f.repo });
  await saveJob(root, { ...stale, createdAt: new Date(0).toISOString() });
  const completed = await createJob(root, { repo: f.repo });
  await saveJob(root, { ...completed, state: 'completed' });
  await pruneJobs(root, { maxCount: 1 });
  assert.equal((await loadJob(root, stale.id)).state, 'queued');
  assert.equal((await loadJob(root, completed.id)).state, 'completed');
});

test('full active budget retains the latest result', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const active = await createJob(root, { repo: f.repo });
  const completed = await createJob(root, { repo: f.repo });
  await saveJob(root, { ...completed, state: 'completed' });
  await pruneJobs(root, { maxCount: 1 });
  assert.equal((await loadJob(root, active.id)).state, 'queued');
  assert.equal((await loadJob(root, completed.id)).state, 'completed');
});

test('dead workers share the bounded history budget', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const worker = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => worker.once('exit', resolve));
  const dead = [];
  for (let i = 0; i < 50; i++) {
    const job = await createJob(root, { repo: f.repo });
    await writeFile(jobPath(root, job.id, 'worker-pid'), String(worker.pid));
    await saveJob(root, { ...job, createdAt: new Date(i).toISOString() });
    dead.push(job);
  }

  const completed = [];
  for (let i = 0; i < 3; i++) {
    const job = await createJob(root, { repo: f.repo });
    await saveJob(root, { ...job, state: 'completed' });
    completed.push(job);
  }

  const retained = await listJobs(root);
  assert.equal(retained.length, 50);
  for (const job of completed)
    assert.ok(retained.some((entry) => entry.id === job.id));

  await assert.rejects(loadJob(root, dead[0].id), /Job not found/);
});

test('stale workers do not crowd out results', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const paused = await createJob(root, { repo: f.repo });
  await saveJob(root, { ...paused, createdAt: new Date(0).toISOString() });
  for (let i = 0; i < 2; i++) {
    const job = await createJob(root, { repo: f.repo });
    await saveJob(root, { ...job, state: 'completed' });
  }

  await pruneJobs(root, { maxCount: 2 });
  assert.equal((await listJobs(root)).length, 3);
});

test('heartbeats distinguish stale jobs from active jobs', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo });
  job.createdAt = new Date(Date.now() - 60_000).toISOString();
  await saveJob(root, job);
  assert.equal(await jobState(root, job), 'interrupted');
  await writeFile(jobPath(root, job.id, 'heartbeat'), '');
  assert.equal(await jobState(root, job), 'queued');
  const past = new Date(Date.now() - 60_000);
  await utimes(jobPath(root, job.id, 'heartbeat'), past, past);
  assert.equal(await jobState(root, job), 'interrupted');
});

test('terminal states take precedence over stale heartbeats', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo });
  job.state = 'completed';
  job.createdAt = new Date(0).toISOString();
  await saveJob(root, job);
  assert.equal(await jobState(root, await loadJob(root, job.id)), 'completed');
});

test('separate checkouts receive separate job stores', () => {
  assert.notEqual(storeRoot('/repo'), storeRoot('/repo-worktree'));
});

test('retention prunes finished jobs and preserves active jobs', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const active = await createJob(root, { repo: f.repo });
  const finished = [];
  for (let i = 0; i < 4; i++) {
    const job = await createJob(root, { repo: f.repo });
    job.state = 'completed';
    job.createdAt = new Date(Date.now() - i * 1000).toISOString();
    await saveJob(root, job);
    finished.push(job);
  }

  await pruneJobs(root, { maxCount: 2 });
  assert.deepEqual(
    new Set((await listJobs(root)).map((job) => job.id)),
    new Set([active.id, finished[0].id]),
  );
  finished[0].finishedAt = new Date(0).toISOString();
  await saveJob(root, finished[0]);
  await createJob(root, { repo: f.repo });
  assert.equal((await loadJob(root, finished[0].id)).state, 'completed');
  assert.equal((await loadJob(root, active.id)).state, 'queued');
});

test('retention keeps recent completions', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const older = await createJob(root, { repo: f.repo });
  const newer = await createJob(root, { repo: f.repo });
  await saveJob(root, {
    ...newer,
    state: 'completed',
    createdAt: '2026-01-02T00:00:00Z',
    finishedAt: '2026-01-03T00:00:00Z',
  });
  await saveJob(root, {
    ...older,
    state: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-04T00:00:00Z',
  });
  await pruneJobs(root, { maxCount: 1 });
  assert.deepEqual(
    (await listJobs(root)).map((job) => job.id),
    [older.id],
  );
});

test('retention enforces the 50-job limit after completion', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const active = await createJob(root, { repo: f.repo });
  for (let i = 0; i < 51; i++) {
    const job = await createJob(root, { repo: f.repo });
    await saveJob(root, {
      ...job,
      state: 'completed',
      finishedAt: new Date(Date.now() + i * 1000).toISOString(),
    });
  }

  const retained = await listJobs(root);
  assert.equal(retained.length, 50);
  assert.ok(retained.some((job) => job.id === active.id));
});

import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createJob,
  jobPath,
  jobState,
  loadJob,
  saveJob,
  storeRoot,
} from '../plugins/cc-plugin-codex/scripts/lib/store.mjs';
import { fixture } from './helpers.mjs';

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

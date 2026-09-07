import assert from 'node:assert/strict';
import { access, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
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
import {
  createJobProgressUpdater,
  saveProgress,
} from '../plugins/claude/scripts/lib/progress.mjs';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { spawn } from 'node:child_process';
import { fixture, eventually } from './helpers.mjs';

test('stale heartbeats require an exited worker to interrupt', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo });
  job.createdAt = new Date(Date.now() - 60_000).toISOString();
  await saveJob(root, job);
  assert.equal(await jobState(root, job), 'queued');
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('exited'), { code: 'ESRCH' });
  });
  assert.equal(await jobState(root, job), 'interrupted');
  await writeFile(jobPath(root, job.id, 'heartbeat'), '');
  assert.equal(await jobState(root, job), 'queued');
  const past = new Date(Date.now() - 60_000);
  await utimes(jobPath(root, job.id, 'heartbeat'), past, past);
  assert.equal(await jobState(root, job), 'interrupted');
});

test('an inaccessible stale worker remains cancellable', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo });
  job.createdAt = new Date(0).toISOString();
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('inaccessible'), { code: 'EPERM' });
  });
  assert.equal(await jobState(root, job), 'queued');
  await writeFile(jobPath(root, job.id, 'cancel'), '');
  assert.equal(await jobState(root, job), 'cancelling');
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

test('retention applies one 50-job limit to every state', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const jobs = [];
  const states = ['running', 'completed', 'queued', 'failed', 'cancelled'];
  for (let i = 0; i < 50; i++) {
    const job = await createJob(root, { repo: f.repo });
    await writeFile(
      jobPath(root, job.id),
      JSON.stringify({
        ...job,
        state: states[i % states.length],
        updatedAt: new Date(i).toISOString(),
      }),
    );
    jobs.push(job);
  }

  await createJob(root, { repo: f.repo });
  assert.equal((await listJobs(root)).length, 50);
  await assert.rejects(loadJob(root, jobs[0].id), /Job not found/);
  await createJob(root, { repo: f.repo });
  assert.equal((await listJobs(root)).length, 50);
  await assert.rejects(loadJob(root, jobs[1].id), /Job not found/);
});

test('saving a job refreshes its retention order', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const older = await createJob(root, { repo: f.repo });
  const newer = await createJob(root, { repo: f.repo });
  for (const [index, job] of [older, newer].entries()) {
    await writeFile(
      jobPath(root, job.id),
      JSON.stringify({
        ...job,
        updatedAt: new Date(index).toISOString(),
      }),
    );
  }

  await saveJob(root, { ...older, state: 'completed' });
  await pruneJobs(root, { maxCount: 1 });
  assert.deepEqual(
    (await listJobs(root)).map((job) => job.id),
    [older.id],
  );
});

for (const updatedAt of [undefined, null, 0]) {
  test(`upstream timestamp coercion: ${updatedAt}`, async (t) => {
    const f = await fixture(t);
    const root = join(f.root, 'store');
    const missing = await createJob(root, { repo: f.repo });
    await writeFile(
      jobPath(root, missing.id),
      JSON.stringify({
        ...missing,
        updatedAt,
      }),
    );
    const current = await createJob(root, { repo: f.repo });
    await saveJob(root, current);
    await pruneJobs(root, { maxCount: 1 });
    assert.deepEqual(
      (await listJobs(root)).map((job) => job.id),
      [current.id],
    );
  });
}

test('only phase and session changes refresh history', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo, state: 'running' });
  const update = createJobProgressUpdater(root, job);
  await update({ phase: 'starting' });
  const stamp = async () => {
    await writeFile(
      jobPath(root, job.id),
      JSON.stringify({
        ...(await loadJob(root, job.id)),
        updatedAt: new Date(0).toISOString(),
      }),
    );
  };
  await stamp();
  await saveProgress(root, job.id, { phase: 'starting', summary: 'A tick' });
  await update({ phase: 'starting', summary: 'Another message' });
  assert.equal(
    (await loadJob(root, job.id)).updatedAt,
    new Date(0).toISOString(),
  );
  await update({ phase: 'reviewing' });
  assert.notEqual(
    (await loadJob(root, job.id)).updatedAt,
    new Date(0).toISOString(),
  );
  await stamp();
  await update({ phase: 'reviewing', claudeSessionId: 'session' });
  assert.notEqual(
    (await loadJob(root, job.id)).updatedAt,
    new Date(0).toISOString(),
  );
  await pruneJobs(root, { maxCount: 0 });
  await update({ phase: 'reviewing', claudeSessionId: 'session' });
  assert.deepEqual(await listJobs(root), []);
  await update({ phase: 'output', claudeSessionId: 'session' });
  assert.equal((await loadJob(root, job.id)).phase, 'output');
});

for (const operation of ['writeFile', 'rename']) {
  test(`a save survives pruning during ${operation}`, async (t) => {
    const f = await fixture(t);
    const root = join(f.root, 'store');
    const job = await createJob(root, { repo: f.repo });
    const module = new URL(
      '../plugins/claude/scripts/lib/store.mjs',
      import.meta.url,
    ).href;
    const script = join(f.root, 'save-race.mjs');
    await writeFile(
      script,
      `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { saveJob, pruneJobs } from ${JSON.stringify(module)};
      const original = fs.${operation};
      fs.${operation} = async (...args) => {
        fs.${operation} = original;
        syncBuiltinESMExports();
        await pruneJobs(${JSON.stringify(root)}, { maxCount: 0 });
        return original(...args);
      };
      syncBuiltinESMExports();
      const job = ${JSON.stringify({ ...job, state: 'completed' })};
      await saveJob(${JSON.stringify(root)}, job);
    `,
    );
    const run = await runProcess(process.execPath, [script]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal((await loadJob(root, job.id)).state, 'completed');
    assert.ok(!(await readdir(root)).some((name) => name.endsWith('.tmp')));
  });
}

for (const owner of ['exited', 'live', 'inaccessible']) {
  test(`orphan cleanup with ${owner} owner`, async (t) => {
    const f = await fixture(t);
    const root = join(f.root, 'store');
    const job = await createJob(root, { repo: f.repo });
    await writeFile(jobPath(root, job.id, 'prompt.json'), 'private prompt');
    t.mock.method(process, 'kill', (pid, signal) => {
      assert.equal(pid, process.pid);
      assert.equal(signal, 0);
      if (owner === 'live') return true;

      throw Object.assign(new Error(owner), {
        code: owner === 'exited' ? 'ESRCH' : 'EPERM',
      });
    });
    await pruneJobs(root, { maxCount: 0 });
    assert.deepEqual(await listJobs(root), []);
    const payload = jobPath(root, job.id, 'prompt.json');
    if (owner === 'exited')
      await assert.rejects(access(payload), { code: 'ENOENT' });
    else await access(payload);
  });
}

test('pruning reclaims dead writers and preserves live writes', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo });
  const module = new URL(
    '../plugins/claude/scripts/lib/store.mjs',
    import.meta.url,
  ).href;
  const script = join(f.root, 'interrupted-save.mjs');
  await writeFile(
    script,
    `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { saveJob } from ${JSON.stringify(module)};
    await fs.writeFile(${JSON.stringify(jobPath(root, job.id, 'worker-pid'))},
      String(process.pid));
    setInterval(() => {}, 1000);
    fs.rename = async (from) => {
      process.stdout.write(from + '\\n');
      await new Promise(() => {});
    };
    syncBuiltinESMExports();
    await saveJob(${JSON.stringify(root)}, ${JSON.stringify(job)});
  `,
  );
  const worker = spawn(process.execPath, [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => worker.once('close', resolve));
  f.cleanup(async () => {
    worker.kill('SIGKILL');
    await exited;
  });
  let output = '';
  worker.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await eventually(() => output.includes('\n'));
  const temporary = output.trim();
  await pruneJobs(root, { maxCount: 0 });
  await access(temporary);
  await access(jobPath(root, job.id, '.'));
  worker.kill('SIGKILL');
  await exited;
  await pruneJobs(root);
  assert.deepEqual(await readdir(root), []);
});

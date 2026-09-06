import { randomUUID } from 'node:crypto';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git } from './git.mjs';
import { jobPath } from './store.mjs';

// A stale lock is intentionally never stolen: a stopped heartbeat does not
// prove that the old writer or its descendants have stopped.
export async function acquireWriteGuard(
  root,
  job,
  platform = process.platform,
) {
  if (platform === 'win32')
    throw new Error(
      'Write rescue is unsupported on Windows: ' +
        'process supervision is unavailable. Use read-only rescue.',
    );
  const token = randomUUID();
  const lock = resolve(
    job.repo,
    (
      await git(job.repo, ['rev-parse', '--git-path', 'claude-rescue.lock'])
    ).trim(),
  );
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `Another write job holds ${lock}. After an interrupted job, ` +
          'confirm its processes have stopped and inspect its recovery ' +
          'record before removing the lock.',
        { cause: error },
      );
    throw error;
  }
  const recovery = jobPath(root, job.id, 'recovery.json');
  const record = {
    jobId: job.id,
    token,
    lock,
    repo: job.repo,
    startedAt: new Date().toISOString(),
  };
  const status = () =>
    git(job.repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  const save = () =>
    writeFile(recovery, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    await handle.writeFile(
      JSON.stringify({ jobId: job.id, recovery, pid: process.pid, token }),
    );
    await handle.close();
    record.before = await status();
    await save();
    job.recovery = recovery;
  } catch (error) {
    await handle.close();
    await releaseLock(lock, token);
    throw error;
  }
  return async () => {
    try {
      record.after = await status();
      record.finishedAt = new Date().toISOString();
      await save();
    } finally {
      await releaseLock(lock, token);
    }
  };
}

async function releaseLock(lock, token) {
  let owner;
  try {
    owner = JSON.parse(await readFile(lock, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (owner.token !== token)
    throw new Error('Write lock ownership changed; leaving the lock intact.');
  await rm(lock);
}

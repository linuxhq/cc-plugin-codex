import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fingerprint } from './git.mjs';

export const terminalStates = ['completed', 'failed', 'cancelled'];

export function storeRoot(repo) {
  const data =
    process.env.CLAUDE_REVIEW_DATA_DIR ||
    join(homedir(), '.codex', 'plugins', 'data', 'claude-review');
  return join(resolve(data), 'jobs', fingerprint(repo).slice(0, 24));
}

export function jobPath(root, id, name = 'job.json') {
  if (!/^review-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID.');

  return name === 'job.json' ? join(root, `${id}.json`) : join(root, id, name);
}

export async function saveJob(root, job) {
  job.updatedAt = new Date().toISOString();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = jobPath(root, job.id);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const data = ['rescue', 'transfer', 'stop-review-gate'].includes(job.command)
    ? { ...job, prompt: undefined }
    : job;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }

  await pruneJobs(root);
}

export async function createJob(root, details) {
  const job = {
    ...details,
    id: `review-${randomUUID()}`,
    state: 'queued',
    createdAt: new Date().toISOString(),
  };
  await mkdir(join(root, job.id), { recursive: true, mode: 0o700 });
  await writeFile(jobPath(root, job.id, 'worker-pid'), String(process.pid), {
    mode: 0o600,
  });
  await writeFile(jobPath(root, job.id, 'session-id'), job.sessionId || '', {
    mode: 0o600,
  });
  await saveJob(root, job);
  return job;
}

export async function loadJob(root, id) {
  try {
    return JSON.parse(await readFile(jobPath(root, id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(`Job not found in this repository: ${id}`, {
        cause: error,
      });

    throw error;
  }
}

export async function listJobs(root) {
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error.code === 'ENOENT') return [];

    throw error;
  }

  const jobs = await Promise.all(
    entries
      .filter((name) => /^review-[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => name.slice(0, -5))
      .map(async (id) => {
        try {
          return await loadJob(root, id);
        } catch (error) {
          // A concurrent creator may have pruned this job.
          if (error.cause?.code === 'ENOENT') return null;

          throw error;
        }
      }),
  );
  return jobs
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function resolveJob(root, reference, predicate = () => true) {
  if (reference && !/^[a-z0-9-]+$/.test(reference))
    throw new Error('Invalid job ID.');

  const jobs = (await listJobs(root)).filter(predicate);
  if (!reference) {
    if (!jobs.length) throw new Error('No review jobs in this repository.');

    return jobs[0];
  }

  const exact = jobs.find((job) => job.id === reference);
  if (exact) return exact;

  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length === 1) return matches[0];

  if (matches.length > 1)
    throw new Error('Job reference is ambiguous. Use a longer job ID.');

  throw new Error(`Job not found in this repository: ${reference}`);
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;

    throw error;
  }
}

export async function jobState(root, job) {
  if (terminalStates.includes(job.state)) return job.state;

  const heartbeat = jobPath(root, job.id, 'heartbeat');
  const lastSeen = (await exists(heartbeat))
    ? (await stat(heartbeat)).mtimeMs
    : Date.parse(job.createdAt);
  if (Date.now() - lastSeen > 30_000 && (await workerExited(root, job)))
    return 'interrupted';

  if (await exists(jobPath(root, job.id, 'cancel'))) return 'cancelling';

  return job.state;
}

// Match upstream: retain the 50 most recently updated jobs, in any state.
export async function pruneJobs(root, { maxCount = 50 } = {}) {
  const jobs = await listJobs(root);
  jobs.sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );
  for (const job of jobs.slice(maxCount)) {
    await rm(jobPath(root, job.id), { force: true });
    await rm(jobPath(root, job.id, 'worker.log'), { force: true });
    if (terminalStates.includes(job.state))
      await rm(join(root, job.id), { recursive: true, force: true });
  }

  await cleanupAbandonedFiles(root);
}

// Only reclaim files whose owning process is known to have exited.
async function cleanupAbandonedFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;

    throw error;
  }

  for (const entry of entries) {
    const temporary = entry.name.match(
      /^review-[a-f0-9-]{36}\.json\.(\d+)\.[a-f0-9-]{36}\.tmp$/,
    );
    if (entry.isFile() && temporary && processExited(Number(temporary[1]))) {
      await rm(join(root, entry.name), { force: true });
    } else if (
      entry.isDirectory() &&
      /^review-[a-f0-9-]{36}$/.test(entry.name) &&
      !(await exists(jobPath(root, entry.name))) &&
      (await workerExited(root, { id: entry.name }))
    ) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

// Called by the owner after execution stops, including failed startup.
export async function cleanupWorker(root, id) {
  if (await exists(jobPath(root, id, 'session-ended')))
    await removeJob(root, id);
  else if (!(await exists(jobPath(root, id))))
    await rm(jobPath(root, id, '.'), { recursive: true, force: true });
}

export async function removeJob(root, id) {
  await rm(jobPath(root, id), { force: true });
  await rm(jobPath(root, id, '.'), { recursive: true, force: true });
}

// PID reuse or inaccessible processes conservatively retain the record.
// Never signal a process using a persisted PID; signal 0 only probes existence.
export async function workerExited(root, job) {
  let pid;
  try {
    pid = Number(await readFile(jobPath(root, job.id, 'worker-pid'), 'utf8'));
  } catch (error) {
    // Cleanup may race with removal of another job's files.
    if (error.code === 'ENOENT') return false;

    throw error;
  }

  return processExited(pid);
}

function processExited(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;

    if (error.code === 'EPERM') return false;

    throw error;
  }
}

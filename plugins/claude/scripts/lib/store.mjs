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

  return join(root, id, name);
}

export async function saveJob(root, job) {
  const path = jobPath(root, job.id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const data = ['rescue', 'transfer'].includes(job.command)
    ? { ...job, prompt: undefined }
    : job;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function createJob(root, details) {
  const job = {
    ...details,
    id: `review-${randomUUID()}`,
    state: 'queued',
    createdAt: new Date().toISOString(),
  };
  await pruneJobs(root);
  await mkdir(join(root, job.id), { recursive: true, mode: 0o700 });
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
      .filter((id) => /^review-[a-f0-9-]{36}$/.test(id))
      .map(async (id) => {
        try {
          return await loadJob(root, id);
        } catch (error) {
          // A concurrent creator may have pruned this finished job.
          if (error.cause?.code === 'ENOENT') return null;

          throw error;
        }
      }),
  );
  return jobs
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function resolveJob(root, reference) {
  if (reference && !/^review-[a-f0-9-]+$/.test(reference))
    throw new Error('Invalid job ID.');

  const jobs = await listJobs(root);
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
  if (Date.now() - lastSeen > 30_000) return 'interrupted';

  if (await exists(jobPath(root, job.id, 'cancel'))) return 'cancelling';

  return job.state;
}

// Keep active jobs regardless of age. Run before each new job is created.
export async function pruneJobs(root, { maxCount = 50 } = {}) {
  const finished = (await listJobs(root)).filter((job) =>
    terminalStates.includes(job.state),
  );
  for (const [index, job] of finished.entries()) {
    if (index >= maxCount)
      await rm(join(root, job.id), { recursive: true, force: true });
  }
}

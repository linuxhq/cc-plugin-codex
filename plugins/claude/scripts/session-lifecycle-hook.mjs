#!/usr/bin/env node
// Adapted from upstream session-lifecycle-hook.mjs; see ../NOTICE.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { workspaceRoot } from './lib/git.mjs';
import { currentSessionId } from './lib/status.mjs';
import {
  jobPath,
  loadJob,
  removeJob,
  storeRoot,
  terminalStates,
  workerExited,
} from './lib/store.mjs';

async function main() {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  const input = raw.trim() ? JSON.parse(raw) : {};
  if ((process.argv[2] || input.hook_event_name) !== 'SessionEnd') return;

  const sessionId = input.session_id || currentSessionId();
  if (!sessionId) return;

  const root = storeRoot(await workspaceRoot(input.cwd || process.cwd()));
  // Execution directories survive history pruning, as upstream's broker does.
  for (const entry of await executionEntries(root)) {
    try {
      await cleanupSessionJob(root, entry.name, sessionId);
    } catch (error) {
      if (error.code === 'ENOENT') continue;

      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

async function executionEntries(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(
      (entry) =>
        entry.isDirectory() && /^review-[a-f0-9-]{36}$/.test(entry.name),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];

    throw error;
  }
}

async function cleanupSessionJob(root, id, sessionId) {
  const owner = await readFile(jobPath(root, id, 'session-id'), 'utf8');
  if (owner !== sessionId) return;

  const job = await loadJob(root, id).catch((error) => {
    if (error.cause?.code === 'ENOENT') return { id };

    throw error;
  });
  await cleanupJob(root, job);
}

async function cleanupJob(root, job) {
  if (terminalStates.includes(job.state) || (await workerExited(root, job))) {
    await removeJob(root, job.id);
  } else {
    // The worker owns its child process and removes its records after stopping.
    await writeFile(jobPath(root, job.id, 'session-ended'), '', {
      mode: 0o600,
    });
    await writeFile(jobPath(root, job.id, 'cancel'), '', { mode: 0o600 }).catch(
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    const latest = await loadJob(root, job.id).catch((error) => {
      if (error.cause?.code === 'ENOENT') return null;

      throw error;
    });
    if (latest && terminalStates.includes(latest.state))
      await removeJob(root, job.id);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
// Adapted from upstream session-lifecycle-hook.mjs; see ../NOTICE.
import { rm, writeFile } from 'node:fs/promises';
import { workspaceRoot } from './lib/git.mjs';
import { currentSessionId } from './lib/status.mjs';
import {
  jobPath,
  jobState,
  listJobs,
  loadJob,
  storeRoot,
  terminalStates,
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
  for (const job of await listJobs(root)) {
    if (job.sessionId !== sessionId) continue;

    await cleanupJob(root, job);
  }
}

async function cleanupJob(root, job) {
  if (terminalStates.includes(job.state)) {
    await rm(jobPath(root, job.id, '.'), { recursive: true, force: true });
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
    if (
      latest &&
      (terminalStates.includes(latest.state) ||
        (await jobState(root, latest)) === 'interrupted')
    )
      await rm(jobPath(root, job.id, '.'), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

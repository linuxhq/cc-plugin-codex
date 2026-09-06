import { readFile, rm } from 'node:fs/promises';
import { executeJob } from './lib/worker.mjs';
import { validatePrompt } from './lib/claude.mjs';
import { jobPath, loadJob, saveJob } from './lib/store.mjs';

const [root, id] = process.argv.slice(2);
try {
  const path = jobPath(root, id, 'prompt.json');
  let prompt;
  try {
    prompt = JSON.parse(await readFile(path, 'utf8'));
    validatePrompt(prompt);
  } finally {
    await rm(path, { force: true });
  }

  const job = await executeJob(root, id, { prompt });
  process.exitCode = job.state === 'completed' ? 0 : 1;
} catch (error) {
  const message = `Worker prompt delivery/execution failed: ${error.message}`;
  try {
    const job = await loadJob(root, id);
    await saveJob(root, {
      ...job,
      state: 'failed',
      error: message,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    /* The job store is unavailable; worker.log retains the failure. */
  }

  console.error(message);
  process.exitCode = 1;
}

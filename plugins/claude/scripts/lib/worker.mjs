import { writeFile } from 'node:fs/promises';
import { reviewWithClaude, validatePrompt } from './claude.mjs';
import { exists, jobPath, loadJob, saveJob, terminalStates } from './store.mjs';
import { saveProgress, updateProgress } from './progress.mjs';

export async function executeJob(root, id, { prompt } = {}) {
  const job = await loadJob(root, id);
  if (terminalStates.includes(job.state)) return job;

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  let progress = updateProgress(
    {},
    {
      phase: 'starting',
      summary: 'Starting Claude.',
    },
  );
  const stopMonitor = monitor(root, id, controller, () => progress);

  try {
    if (prompt) job.prompt = prompt;

    validatePrompt(job.prompt);
    if (await exists(jobPath(root, id, 'cancel'))) controller.abort();

    if (controller.signal.aborted) throw new Error('Review cancelled.');

    job.state = 'running';
    job.startedAt = new Date().toISOString();
    await saveJob(root, job);
    job.output = await reviewWithClaude(job, controller.signal, (update) => {
      progress = updateProgress(progress, update);
    });
    job.state = controller.signal.aborted ? 'cancelled' : 'completed';
  } catch (error) {
    job.state = controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = error.message;
  } finally {
    await stopMonitor();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }

  job.finishedAt = new Date().toISOString();
  job.elapsedMs =
    Date.parse(job.finishedAt) - Date.parse(job.startedAt || job.createdAt);
  discardPrompt(job);
  job.progress = { ...progress, phase: job.state };
  await saveJob(root, job);
  return job;
}

function monitor(root, id, controller, progress) {
  let stopped = false;
  let timer;
  let pending = Promise.resolve();
  const tick = async () => {
    await writeFile(jobPath(root, id, 'heartbeat'), '', { mode: 0o600 });
    if (await exists(jobPath(root, id, 'cancel'))) controller.abort();

    await saveProgress(root, id, progress());
  };
  const schedule = () => {
    pending = tick()
      .catch(() => controller.abort())
      .finally(() => {
        if (!stopped) timer = setTimeout(schedule, 500);
      });
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}

function discardPrompt(job) {
  if (['stop-review-gate', 'rescue', 'transfer'].includes(job.command))
    delete job.prompt;
}

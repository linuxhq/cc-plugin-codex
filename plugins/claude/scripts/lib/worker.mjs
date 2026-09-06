import { acquireWriteGuard } from './write-guard.mjs';
import { gateSnapshot } from './gate-snapshot.mjs';
import { writeFile } from 'node:fs/promises';
import { reviewWithClaude } from './claude.mjs';
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
  let releaseWrite;
  try {
    if (job.write) releaseWrite = await acquireWriteGuard(root, job);
    if (await exists(jobPath(root, id, 'cancel'))) controller.abort();
    if (controller.signal.aborted) throw new Error('Review cancelled.');
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    await saveJob(root, job);
    if (prompt) job.prompt = prompt;
    job.output = await reviewWithClaude(job, controller.signal, (update) => {
      progress = updateProgress(progress, update);
    });
    job.state = controller.signal.aborted ? 'cancelled' : 'completed';
    await validateReviewSnapshot(job);
  } catch (error) {
    job.state = controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = error.message;
  } finally {
    await stopMonitor();
    await finishWrite(releaseWrite, job);
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

async function validateReviewSnapshot(job) {
  if (
    job.command === 'adversarial-review' &&
    job.reviewSnapshot !== (await gateSnapshot(job.repo))
  )
    delete job.reviewSnapshot;
}

function discardPrompt(job) {
  if (['stop-review-gate', 'rescue', 'transfer'].includes(job.command))
    delete job.prompt;
}

async function finishWrite(release, job) {
  try {
    await release?.();
  } catch (error) {
    job.warning = `Could not finish recovery record: ${error.message}`;
  }
}

import { writeFile } from 'node:fs/promises';
import { reviewWithClaude, validatePrompt } from './claude.mjs';
import {
  exists,
  jobPath,
  loadJob,
  cleanupWorker,
  saveJob,
  terminalStates,
} from './store.mjs';
import {
  appendFinalOutput,
  createProgressReporter,
  createJobProgressUpdater,
  saveProgress,
  updateProgress,
} from './progress.mjs';

export async function executeJob(root, id, options = {}) {
  try {
    return await runJob(root, id, options);
  } finally {
    await cleanupWorker(root, id);
  }
}

async function runJob(root, id, { prompt, stderr = false }) {
  const job = await loadJob(root, id);
  if (terminalStates.includes(job.state)) return job;

  const directory = job.sessionId ? jobPath(root, id, '.') : undefined;
  const report = createProgressReporter(root, id, { stderr });
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
  let stopMonitor = async () => {};
  let outcome = 'completed';

  try {
    if (prompt) job.prompt = prompt;

    validatePrompt(job.prompt);
    report(progress);
    if (await exists(jobPath(root, id, 'cancel'))) controller.abort();

    if (controller.signal.aborted) throw new Error('Review cancelled.');

    job.state = 'running';
    job.startedAt = new Date().toISOString();
    await saveJob(root, job);
    stopMonitor = monitor(root, job, controller, () => progress);
    job.output = await reviewWithClaude(
      job,
      controller.signal,
      (update) => {
        progress = updateProgress(progress, update);
        report(update);
      },
      directory,
    );
  } catch (error) {
    outcome = 'failed';
    job.error = error.message;
  } finally {
    await stopMonitor();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }

  // Drain progress writes before publishing any terminal state.
  job.state = controller.signal.aborted ? 'cancelled' : outcome;
  job.finishedAt = new Date().toISOString();
  job.elapsedMs =
    Date.parse(job.finishedAt) - Date.parse(job.startedAt || job.createdAt);
  discardPrompt(job);
  job.progress = updateProgress(progress, {
    phase: job.state === 'completed' ? 'done' : job.state,
    summary: finalSummary(job),
  });
  await saveJob(root, job);
  appendFinalOutput(root, job);
  return job;
}

function finalSummary(job) {
  const output =
    job.state === 'completed'
      ? job.structuredOutput?.summary || job.rawOutput || job.output
      : job.error;
  return String(output || job.state)
    .split(/\r?\n/)
    .find((line) => line.trim());
}

function monitor(root, job, controller, progress) {
  const { id } = job;
  const updateJob = createJobProgressUpdater(root, job);
  let stopped = false;
  let timer;
  let pending = Promise.resolve();
  const tick = async () => {
    await writeFile(jobPath(root, id, 'heartbeat'), '', { mode: 0o600 });
    if (await exists(jobPath(root, id, 'cancel'))) controller.abort();

    const current = progress();
    await saveProgress(root, id, current);
    await updateJob(current);
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

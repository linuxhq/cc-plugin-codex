import { readFile, rename, writeFile } from 'node:fs/promises';
import { jobPath } from './store.mjs';

export function updateProgress(previous, update) {
  const summary = String(update.summary || '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const preview = previous.preview ?? [];
  return {
    claudeSessionId: update.claudeSessionId || previous.claudeSessionId,
    phase: update.phase || previous.phase,
    summary,
    updatedAt: new Date().toISOString(),
    preview:
      summary && preview.at(-1) !== summary
        ? [...preview, summary].slice(-4)
        : preview,
  };
}

export async function saveProgress(root, id, progress) {
  const path = jobPath(root, id, 'progress.json');
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(progress), { mode: 0o600 });
  await rename(temporary, path);
}

export async function readProgress(root, job) {
  if (job.progress) return job.progress;

  try {
    return JSON.parse(await readFile(jobPath(root, job.id, 'progress.json')));
  } catch (error) {
    if (error.code === 'ENOENT') return {};

    throw error;
  }
}

export function formatProgress(job, state, progress, detailed) {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const start = Date.parse(job.startedAt || job.createdAt);
  const duration = formatDuration(start, end);
  const phase = progressPhase(state, progress);
  const elapsedLabel = job.finishedAt ? 'Duration' : 'Elapsed';
  const lines = [
    `${job.id}  ${state}  ${job.command}  ${job.createdAt}`,
    `  ${duration ? `${elapsedLabel}: ${duration}  ` : ''}Phase: ${phase}`,
  ];
  if (progress.summary) lines.push(`  Summary: ${progress.summary}`);

  if (progress.updatedAt) lines.push(`  Last update: ${progress.updatedAt}`);

  if (detailed && progress.preview?.length)
    lines.push('  Progress:', ...progress.preview.map((line) => `    ${line}`));

  return lines.join('\n');
}

export function formatDuration(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;

  if (minutes > 0) return `${minutes}m ${seconds}s`;

  return `${seconds}s`;
}

export function progressPhase(state, progress = {}) {
  if (state === 'completed') return 'done';

  return ['queued', 'running', 'cancelling'].includes(state)
    ? progress.phase || state
    : state;
}

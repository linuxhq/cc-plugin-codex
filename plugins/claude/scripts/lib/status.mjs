import { setTimeout as sleep } from 'node:timers/promises';
import { readGateConfig } from './gate-config.mjs';
import { formatProgress, readProgress } from './progress.mjs';
import { jobState, listJobs, loadJob, resolveJob } from './store.mjs';

export function currentSessionId() {
  return process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null;
}

export async function jobSnapshot(root, job) {
  const data = { ...job };
  delete data.prompt;
  const state = await jobState(root, job);
  const progress = await readProgress(root, job);
  const end = Date.parse(job.finishedAt || new Date().toISOString());
  const start = Date.parse(job.startedAt || job.createdAt);
  return {
    ...data,
    state,
    status: state,
    progress,
    updatedAt: [
      job.createdAt,
      job.startedAt,
      job.finishedAt,
      job.updatedAt,
      progress.updatedAt,
    ]
      .filter(Boolean)
      .sort()
      .at(-1),
    elapsedMs: Math.max(0, end - start),
  };
}

export const active = (job) =>
  ['queued', 'running', 'cancelling'].includes(job.state);

export async function sessionJobs(root) {
  let jobs = await listJobs(root);
  const sessionId = currentSessionId();
  if (sessionId) jobs = jobs.filter((job) => job.sessionId === sessionId);
  const snapshots = await Promise.all(
    jobs.map((job) => jobSnapshot(root, job)),
  );
  return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function statusReport(root, options = {}) {
  if (options.id) return singleStatus(root, options);
  const sessionId = currentSessionId();
  const snapshots = await sessionJobs(root);
  const running = snapshots.filter(active);
  const finished = snapshots.filter((job) => !active(job));
  const latestFinished = finished[0] || null;
  const recent = (options.all ? snapshots : snapshots.slice(0, 8)).filter(
    (job) => !active(job) && job.id !== latestFinished?.id,
  );
  const payload = {
    workspaceRoot: options.repo,
    sessionId,
    config: { stopReviewGate: (await readGateConfig(root)).enabled },
    running,
    latestFinished,
    recent,
  };
  const visible = [
    ...running,
    ...(latestFinished ? [latestFinished] : []),
    ...recent,
  ];
  return { payload, text: renderTable(visible, payload.config.stopReviewGate) };
}

async function singleStatus(root, options) {
  const timeoutMs = options['timeout-ms'] ?? 240_000;
  const pollMs = options['poll-interval-ms'] ?? 2000;
  const deadline = Date.now() + timeoutMs;
  let job = await jobSnapshot(root, await resolveJob(root, options.id));
  while (options.wait && active(job) && Date.now() < deadline) {
    await sleep(Math.min(pollMs, 60_000, Math.max(0, deadline - Date.now())));
    job = await jobSnapshot(root, await loadJob(root, job.id));
  }
  const waitTimedOut = Boolean(options.wait && active(job));
  const text = formatProgress(job, job.state, job.progress, true);
  return {
    payload: { job, ...(options.wait ? { waitTimedOut, timeoutMs } : {}) },
    text:
      text + (waitTimedOut ? '\nWait timed out; the job is still active.' : ''),
  };
}

function cell(value) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\|/g, '\\|');
}

function renderTable(jobs, gate) {
  const lines = [
    '| Job | Kind | Status | Phase | Time | Summary | Gate | Actions |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const job of jobs) {
    const followup = active(job) ? 'cancel' : 'result';
    const values = [
      job.id,
      job.command,
      job.state,
      active(job) ? job.progress.phase || job.state : job.state,
      `${Math.floor(job.elapsedMs / 1000)}s`,
      job.progress.summary || job.error,
      gate ? 'enabled' : 'disabled',
      `$claude:status ${job.id}; $claude:${followup} ${job.id}`,
    ];
    lines.push(`| ${values.map(cell).join(' | ')} |`);
  }
  if (!jobs.length)
    lines.push('| No review jobs in this session. | | | | | | | |');
  return lines.join('\n');
}

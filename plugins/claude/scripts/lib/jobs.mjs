import { renderGateResult } from './gate-output.mjs';
import { randomUUID } from 'node:crypto';
import { persistentCommands, prepareTask } from './tasks.mjs';
import { spawn } from 'node:child_process';
import { open, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './claude.mjs';
import { collectReview } from './git.mjs';
import {
  active,
  currentSessionId,
  jobSnapshot,
  sessionJobs,
  statusReport,
} from './status.mjs';
import {
  createJob,
  jobPath,
  jobState,
  resolveJob,
  saveJob,
  terminalStates,
} from './store.mjs';

export async function prepareJob(repo, root, options, target) {
  const persistent = persistentCommands.includes(options.command);
  const task = ['rescue', 'transfer'].includes(options.command)
    ? await prepareTask(root, options, process.cwd())
    : null;
  target ??= persistent
    ? { scope: options.command }
    : await collectReview(repo, options);
  const prompt =
    task?.prompt || (await buildPrompt(options.command, target, options.focus));
  const job = await createJob(root, {
    repo,
    command: options.command,
    sessionId: options.sessionId || currentSessionId(),
    model: options.model,
    effort: options.effort,
    ...(persistent
      ? {
          write: Boolean(options.write),
          resumeSessionId: task?.resumeSessionId,
          requestedSessionId: task?.resumeSessionId ? undefined : randomUUID(),
        }
      : {}),
    target: {
      scope: target.scope,
      base: target.base,
      inputMode: target.inputMode,
    },
    ...(options.command === 'stop-review-gate' ? {} : { prompt }),
  });
  return { ...job, prompt };
}

export async function launchBackground(root, job) {
  const log = await open(jobPath(root, job.id, 'worker.log'), 'a', 0o600);
  const payload = jobPath(root, job.id, 'prompt.json');
  try {
    await writeFile(payload, JSON.stringify(job.prompt), {
      mode: 0o600,
      flag: 'wx',
    });
    const worker = fileURLToPath(new URL('../worker.mjs', import.meta.url));
    const child = spawn(process.execPath, [worker, root, job.id], {
      cwd: job.repo,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });

    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    await writeFile(jobPath(root, job.id, 'worker-pid'), String(child.pid), {
      mode: 0o600,
    });
    child.unref();
  } catch (error) {
    await rm(payload, { force: true });
    await saveJob(root, { ...job, state: 'failed', error: error.message });
    throw error;
  } finally {
    await log.close();
  }
}

export async function selectJob(root, id) {
  return resolveJob(root, id);
}

export async function selectResultJob(root, id) {
  if (id) {
    const snapshots = await sessionJobs(root, null);
    const finishedIds = new Set(
      snapshots.filter((job) => !active(job)).map((job) => job.id),
    );
    try {
      return await resolveJob(root, id, (job) => finishedIds.has(job.id));
    } catch (error) {
      if (!error.message.startsWith('Job not found')) throw error;
    }

    const activeIds = new Set(snapshots.filter(active).map((job) => job.id));
    const job = await resolveJob(root, id, (job) => activeIds.has(job.id));
    throw new Error(
      `Job ${job.id} is still ${job.state}. ` +
        'Check $claude:status and try again once it finishes.',
    );
  }

  const jobs = await sessionJobs(root);
  const finished = jobs.find((job) => !active(job));
  if (finished) return finished;

  if (jobs.length)
    throw new Error(
      `Job ${jobs[0].id} is still ${jobs[0].state}. ` +
        'Check $claude:status and try again once it finishes.',
    );

  throw new Error('No finished review jobs in this session.');
}

export async function selectCancelableJob(root, id) {
  if (id) {
    const snapshots = await sessionJobs(root, null);
    const activeIds = new Set(snapshots.filter(active).map((job) => job.id));
    try {
      return await resolveJob(root, id, (job) => activeIds.has(job.id));
    } catch (error) {
      if (error.message.startsWith('Job not found'))
        throw new Error(`No active job found for ${id}.`, { cause: error });

      throw error;
    }
  }

  const jobs = (await sessionJobs(root)).filter(active);
  if (jobs.length === 1) return jobs[0];

  if (jobs.length > 1)
    throw new Error(
      'Multiple review jobs are active. Pass a job ID to $claude:cancel.',
    );

  throw new Error('No active review jobs to cancel in this session.');
}

export async function status(root, id, options = {}) {
  return (await statusReport(root, { ...options, id })).text;
}

export async function cancelJob(root, id) {
  const job = await selectCancelableJob(root, id);
  const state = await jobState(root, job);
  if (terminalStates.includes(state)) return `${job.id} is already ${state}.`;

  // Only the owning worker signals its child, avoiding persisted PID reuse.
  await writeFile(jobPath(root, job.id, 'cancel'), '', { mode: 0o600 });
  if (state === 'interrupted')
    return `${job.id} was interrupted; cancellation recorded.`;

  return [
    `Cancellation requested for ${job.id}.`,
    `Use $claude:status ${job.id} to confirm.`,
  ].join('\n');
}

export async function result(root, id) {
  return jobResult(root, await selectResultJob(root, id));
}

export async function jobResult(root, completed) {
  const job = await jobSnapshot(root, completed);
  const state = await jobState(root, job);
  const continuation = job.claudeSessionId
    ? `\nClaude session: ${job.claudeSessionId}\n` +
      `Continue: claude --resume ${job.claudeSessionId}`
    : '';
  if (state !== 'completed') {
    return {
      text:
        `${job.id}: ${state}${job.error ? `\n${job.error}` : ''}` +
        (job.rawOutput ? `\n\n${job.rawOutput}` : '') +
        continuation +
        (job.write
          ? '\nWrite job may have left partial edits. ' +
            'Inspect the working tree before continuing.'
          : ''),
      failed: ['failed', 'cancelled', 'interrupted'].includes(state),
    };
  }

  const output =
    job.command === 'stop-review-gate'
      ? renderGateResult(job.output)
      : job.output;
  return {
    text:
      output +
      (job.warning ? `\n\nWarning: ${job.warning}` : '') +
      `\n\nReview job: ${job.id}${continuation}`,
    failed: false,
  };
}

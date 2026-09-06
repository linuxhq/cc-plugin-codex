import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './claude.mjs';
import { collectReview } from './git.mjs';
import { currentSessionId, statusReport } from './status.mjs';
import {
  createJob,
  jobPath,
  jobState,
  resolveJob,
  saveJob,
  terminalStates,
} from './store.mjs';

export async function prepareJob(repo, root, options, target) {
  target ??= await collectReview(repo, { ...options, contextRoot: root });
  if (!target.context) return null;
  const fileFocus = options['focus-file']
    ? await readFile(options['focus-file'], 'utf8')
    : '';
  const focus = [fileFocus, options.focus].filter(Boolean).join('\n');
  const prompt = await buildPrompt(options.command, target, focus);
  return createJob(root, {
    repo,
    command: options.command,
    sessionId: options.sessionId || currentSessionId(),
    model: options.model,
    effort: options.effort,
    target: {
      scope: target.scope,
      base: target.base,
      fingerprint: target.fingerprint,
      contextDirectory: target.contextDirectory,
      contextPath: target.contextPath,
      contextBytes: target.contextBytes,
      inputMode: target.inputMode,
    },
    prompt,
  });
}

export async function launchBackground(root, job) {
  const log = await open(jobPath(root, job.id, 'worker.log'), 'a', 0o600);
  try {
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
    child.unref();
  } catch (error) {
    await saveJob(root, { ...job, state: 'failed', error: error.message });
    throw error;
  } finally {
    await log.close();
  }
}

export async function selectJob(root, id) {
  return resolveJob(root, id);
}

export async function status(root, id, options = {}) {
  return (await statusReport(root, { ...options, id })).text;
}

export async function cancelJob(root, id) {
  const job = await selectJob(root, id);
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
  const job = await selectJob(root, id);
  const state = await jobState(root, job);
  if (state !== 'completed') {
    return {
      text: `${job.id}: ${state}${job.error ? `\n${job.error}` : ''}`,
      failed: ['failed', 'cancelled', 'interrupted'].includes(state),
    };
  }
  let warning = '';
  try {
    if (job.target.scope === 'turn') {
      return { text: `${job.output}\n\nReview job: ${job.id}`, failed: false };
    }
    const current = await collectReview(job.repo, {
      ...job.target,
      fingerprintOnly: true,
    });
    if (current.fingerprint !== job.target.fingerprint)
      warning = 'Review target has changed since this run.\n\n';
  } catch {
    warning = 'Could not verify whether the review target has changed.\n\n';
  }
  return {
    text: `${warning}${job.output}\n\nReview job: ${job.id}`,
    failed: false,
  };
}

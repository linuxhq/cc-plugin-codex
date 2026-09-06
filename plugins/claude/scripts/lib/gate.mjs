import { readGateConfig } from './gate-config.mjs';
import { repositoryRoot } from './git.mjs';
import { prepareJob } from './jobs.mjs';
import { runProcess } from './process.mjs';
import { active, sessionJobs } from './status.mjs';
import { storeRoot } from './store.mjs';
import { executeJob } from './worker.mjs';

import { gateFailure, parseGateOutput } from './gate-output.mjs';
export { gateFailure, parseGateOutput } from './gate-output.mjs';

export async function runGate(input) {
  if (input.hook_event_name !== 'Stop') return {};
  let repo;
  try {
    repo = await repositoryRoot(input.cwd || process.cwd());
  } catch {
    return {
      systemMessage:
        'Claude review gate skipped: the working directory is not ' +
        'an accessible Git checkout.',
    };
  }
  const root = storeRoot(repo);
  const running = (await sessionJobs(root, input.session_id || undefined)).find(
    active,
  );
  const note = running
    ? `Claude job ${running.id} is still running. ` +
      `Check $claude:status or use $claude:cancel ${running.id}.`
    : '';
  let config;
  try {
    config = await readGateConfig(root);
  } catch (error) {
    return gateFailure(
      `Cannot read review gate configuration: ${error.message}`,
    );
  }
  if (!config.enabled) return note ? { systemMessage: note } : {};
  if (input.stop_hook_active)
    return {
      systemMessage:
        'Claude automatic review skipped after a continued Stop turn.',
    };
  try {
    const available = await runProcess('claude', ['--version']);
    if (available.code !== 0) throw new Error('Claude is unavailable.');
  } catch {
    return {
      systemMessage: [
        'Claude is not set up for the review gate. Run $claude:setup.',
        note,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  const decision = await reviewResponse(repo, root, input);
  return withNote(decision, note);
}

function withNote(decision, note) {
  if (note) {
    const field = decision.reason ? 'reason' : 'systemMessage';
    decision[field] = [note, decision[field]].filter(Boolean).join('\n');
  }
  return decision;
}

async function reviewResponse(repo, root, input) {
  const job = await prepareJob(
    repo,
    root,
    {
      command: 'stop-review-gate',
      sessionId: input.session_id,
      focus: String(input.last_assistant_message ?? '').trim(),
    },
    { scope: 'response' },
  );
  const completed = await executeJob(root, job.id);
  if (completed.state !== 'completed')
    return gateFailure(
      `${completed.state}: ${completed.error || 'Review did not complete.'}` +
        `\nReview job: ${job.id}`,
    );
  const decision = parseGateOutput(completed.output);
  if (!decision.reason && !decision.systemMessage) return decision;
  const field = decision.reason ? 'reason' : 'systemMessage';
  decision[field] += `\n\nFull review: $claude:result ${job.id}`;
  return decision;
}

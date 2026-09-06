import { readGateConfig } from './gate-config.mjs';
import { repositoryRoot } from './git.mjs';
import { prepareJob } from './jobs.mjs';
import { runProcess } from './process.mjs';
import { active, sessionJobs } from './status.mjs';
import { storeRoot } from './store.mjs';
import { executeJob } from './worker.mjs';

const recovery =
  'Run $claude:review for a manual review.\n' +
  "Run $claude:setup --disable-review-gate to disable this checkout's gate.";

export function gateFailure(message) {
  return {
    decision: 'block',
    reason: `Claude automatic review did not pass:\n${message}\n${recovery}`,
  };
}

export function parseGateOutput(output) {
  const text = String(output ?? '').trim();
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (firstLine.startsWith('ALLOW:')) return {};
  if (firstLine.startsWith('BLOCK:')) {
    return {
      decision: 'block',
      reason:
        'Claude stop-time review found issues that still need fixes before ' +
        `ending the session: ${firstLine.slice('BLOCK:'.length).trim()}`,
    };
  }
  return gateFailure('The reviewer returned an invalid decision.');
}

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
  const running = (await sessionJobs(root)).find(active);
  const note = running
    ? `Claude job ${running.id} is still running. ` +
      `Check $claude:status or use $claude:cancel ${running.id}.`
    : '';
  if (!(await readGateConfig(root)).enabled)
    return note ? { systemMessage: note } : {};
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
  if (note) {
    if (decision.reason) decision.reason = `${note}\n${decision.reason}`;
    else decision.systemMessage = note;
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
  if (decision.reason) decision.reason += `\nReview job: ${job.id}`;
  return decision;
}

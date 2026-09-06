import { readGateConfig } from './gate-config.mjs';
import { repositoryRoot } from './git.mjs';
import { prepareJob } from './jobs.mjs';
import { beginTurn, collectTurn } from './turn.mjs';
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
  if (/^ALLOW: \S.*$/.test(firstLine)) return {};
  if (/^BLOCK: \S.*$/.test(firstLine)) {
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
  if (!input || Array.isArray(input) || typeof input !== 'object')
    throw new Error('Expected a hook event object.');
  if (!['Stop', 'UserPromptSubmit'].includes(input.hook_event_name)) return {};
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
  if (!(await readGateConfig(root)).enabled) return {};
  if (input.hook_event_name === 'UserPromptSubmit') {
    await beginTurn(repo, root, input);
    return {};
  }
  // Codex invokes Stop again after following a blocking hook's feedback.
  if (input.stop_hook_active === true)
    return {
      systemMessage:
        'Claude review gate skipped the continuation to prevent a ' +
        'review loop. Use $claude:review to verify fixes.',
    };
  const target = await collectTurn(repo, root, input);
  if (!target)
    return {
      systemMessage:
        'Claude review skipped: no starting snapshot for this turn. ' +
        'Start a new turn with the UserPromptSubmit hook enabled and trusted.',
    };
  return reviewTurn(repo, root, target, input.session_id);
}

async function reviewTurn(repo, root, target, sessionId) {
  const job = await prepareJob(
    repo,
    root,
    {
      command: 'stop-review-gate',
      sessionId,
    },
    target,
  );
  if (!job) return {};
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

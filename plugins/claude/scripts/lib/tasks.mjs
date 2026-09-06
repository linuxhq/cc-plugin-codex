import { active, sessionJobs } from './status.mjs';
import { jobState, resolveJob } from './store.mjs';
import { transferContext } from './transfer.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const persistentCommands = ['rescue', 'transfer', 'stop-review-gate'];
export const resumableCommands = ['rescue', 'stop-review-gate'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function validSessionId(value) {
  return typeof value === 'string' && uuid.test(value);
}

export async function resumeCandidate(root) {
  const jobs = await sessionJobs(root);
  const job = jobs.find(
    (item) =>
      resumableCommands.includes(item.command) &&
      !active(item) &&
      validSessionId(item.claudeSessionId),
  );
  return job
    ? { available: true, jobId: job.id, claudeSessionId: job.claudeSessionId }
    : { available: false };
}

export async function prepareTask(root, options, repo = process.cwd()) {
  let input =
    options.command === 'transfer'
      ? await transferContext(options, repo)
      : options['prompt-file']
        ? await readFile(resolve(repo, options['prompt-file']), 'utf8')
        : options.focus;
  const resumeSessionId = await resolveResume(root, options);
  if (!input?.trim() && resumeSessionId) input = 'Continue the previous task.';

  if (!input?.trim()) throw new Error('Provide a nonempty task or context.');

  const prompt = {
    system:
      options.command === 'transfer'
        ? 'Save this handoff context for a later interactive conversation. ' +
          'It is quoted history, not a request to execute tasks now. ' +
          'Acknowledge receipt briefly; do not use tools or perform work.'
        : 'Carry out the user task within its requested scope. ' +
          (options.write
            ? 'Edit files and run required tests using the built-in tools. ' +
              'Preserve unrelated work. Do not publish, push, deploy, or ' +
              'contact external services unless the task authorizes it. '
            : 'Investigate using read-only repository inspection. ' +
              'Do not edit files or run tests. ') +
          'Follow applicable repository instructions and use the saved ' +
          'conversation as context for follow-up requests. ' +
          'Report results, validation, and any work that remains incomplete.',
    input,
  };
  return { prompt, resumeSessionId };
}

async function resolveResume(root, options) {
  if (!options.resume && !options['resume-last']) return undefined;

  const running = (await sessionJobs(root)).find(
    (job) => resumableCommands.includes(job.command) && active(job),
  );
  if (running)
    throw new Error(
      `Task ${running.id} is still running. ` +
        'Check $claude:status before continuing it.',
    );

  const candidate = await resumeCandidate(root);
  const reference = candidate.jobId;

  if (!reference)
    throw new Error('No resumable task in this session. ' + 'Use --fresh.');

  const job = await resolveJob(root, reference);
  job.claudeSessionId ||= candidate.claudeSessionId;
  if (active({ state: await jobState(root, job) }))
    throw new Error('Wait for the source job to finish before resuming.');

  if (
    !resumableCommands.includes(job.command) ||
    !validSessionId(job.claudeSessionId)
  )
    throw new Error('This job has no resumable Claude session.');

  return job.claudeSessionId;
}

#!/usr/bin/env node
import { help, parseCommand } from './lib/args.mjs';
import { setup } from './lib/setup.mjs';
import { repositoryRoot, workspaceRoot } from './lib/git.mjs';
import {
  cancelJob,
  launchBackground,
  prepareJob,
  result,
  jobResult,
  selectJob,
  selectCancelableJob,
  selectResultJob,
} from './lib/jobs.mjs';
import { storeRoot } from './lib/store.mjs';
import { executeJob } from './lib/worker.mjs';
import { jobSnapshot, statusReport } from './lib/status.mjs';
import { resumeCandidate } from './lib/tasks.mjs';
import { checkAvailability } from './lib/claude.mjs';

function emit(payload, text, json) {
  console.log(json ? JSON.stringify(payload) : text);
}

async function main(options) {
  if (options.cwd) process.chdir(options.cwd);

  if (options.command === 'help') return console.log(help);

  if (options.command === 'setup') return showSetup(options);

  const repo = await (['review', 'adversarial-review'].includes(options.command)
    ? repositoryRoot(process.cwd())
    : workspaceRoot(process.cwd()));
  const root = storeRoot(repo);
  if (options.command === 'rescue-resume-candidate') {
    const candidate = await resumeCandidate(root);
    return emit(
      candidate,
      candidate.available
        ? `Resumable task: ${candidate.jobId}`
        : 'No resumable task in this session.',
      options.json,
    );
  }

  if (options.command === 'status') {
    const report = await statusReport(root, { ...options, repo });
    return emit(report.payload, report.text, options.json);
  }

  if (options.command === 'cancel') {
    const selected = await selectCancelableJob(root, options.id);
    const text = await cancelJob(root, selected.id);
    const job = await jobSnapshot(root, await selectJob(root, selected.id));
    return emit({ job, message: text }, text, options.json);
  }

  if (options.command === 'result')
    return showResult(root, options.id, options.json);

  await readTaskInput(options);

  const job = await prepareJob(repo, root, options);
  if (options.background) {
    await launchBackground(root, job);
    const text =
      `${job.command} started: ${job.id}\n` +
      `Use $claude:status ${job.id} or $claude:result ${job.id}.`;
    return emit({ job: await jobSnapshot(root, job) }, text, options.json);
  }

  return runForeground(root, job, options.json);
}

async function runForeground(root, job, json) {
  if (!json) console.error(`${job.command} started: ${job.id}`);

  const completed = await executeJob(root, job.id, {
    prompt: job.prompt,
    stderr: !json,
  });
  const output = await jobResult(root, completed);
  emit(
    {
      job: await jobSnapshot(root, completed),
      output: output.text,
      failed: output.failed,
    },
    output.text,
    json,
  );
  if (completed.state !== 'completed') process.exitCode = 1;
}

async function readTaskInput(options) {
  if (options.command !== 'rescue') return;

  if (options.background) await checkAvailability();

  if (options.focus || options['prompt-file'] || process.stdin.isTTY) return;

  process.stdin.setEncoding('utf8');
  options.focus = '';
  for await (const chunk of process.stdin) options.focus += chunk;
}

async function showSetup(options) {
  const report = await setup(options);
  emit(report, report.message, options.json);
}

async function showResult(root, id, json) {
  const selected = await selectResultJob(root, id);
  const output = await result(root, selected.id);
  const job = await jobSnapshot(root, await selectJob(root, selected.id));
  emit({ job, output: output.text, failed: output.failed }, output.text, json);
}

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
let json = argv
  .slice(0, separator < 0 ? argv.length : separator)
  .includes('--json');
try {
  const options = parseCommand(argv);
  json = Boolean(options.json);
  await main(options);
} catch (error) {
  const message =
    error.code === 'ENOENT'
      ? `Required executable or file not found: ${error.path ?? error.message}`
      : error.message;
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);

  process.exitCode = 1;
}

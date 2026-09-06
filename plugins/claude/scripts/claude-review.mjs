#!/usr/bin/env node
import { help, parseCommand } from './lib/args.mjs';
import { setup } from './lib/setup.mjs';
import { repositoryRoot } from './lib/git.mjs';
import {
  cancelJob,
  launchBackground,
  prepareJob,
  result,
  selectJob,
} from './lib/jobs.mjs';
import { storeRoot } from './lib/store.mjs';
import { executeJob } from './lib/worker.mjs';
import { jobSnapshot, statusReport } from './lib/status.mjs';
import { readGateConfig } from './lib/gate-config.mjs';

function emit(payload, text, json) {
  console.log(json ? JSON.stringify(payload) : text);
}

async function main(options) {
  if (options.cwd) process.chdir(options.cwd);
  if (options.command === 'help') return console.log(help);
  if (options.command === 'setup') return showSetup(options);
  const repo = await repositoryRoot(process.cwd());
  const root = storeRoot(repo);
  if (options.command === 'status') {
    const report = await statusReport(root, { ...options, repo });
    return emit(report.payload, report.text, options.json);
  }
  if (options.command === 'cancel') {
    const selected = await selectJob(root, options.id);
    const text = await cancelJob(root, selected.id);
    const job = await jobSnapshot(root, await selectJob(root, selected.id));
    return emit({ job, message: text }, text, options.json);
  }
  if (options.command === 'result')
    return showResult(root, options.id, options.json);
  const job = await prepareJob(repo, root, options);
  if (!job) {
    const text = 'No changes to review in the selected scope.';
    return emit({ skipped: true, message: text }, text, options.json);
  }
  if (options.background) {
    await launchBackground(root, job);
    const text =
      `Review started: ${job.id}\n` +
      `Use $claude:status ${job.id} or $claude:result ${job.id}.`;
    return emit({ job: await jobSnapshot(root, job) }, text, options.json);
  }
  console.error(`Review started: ${job.id}`);
  await executeJob(root, job.id);
  await showResult(root, job.id, options.json);
}

async function showSetup(options) {
  const text = await setup(options);
  let repo = null;
  try {
    repo = await repositoryRoot(process.cwd());
  } catch {
    // Setup can check the CLI outside a Git repository.
  }
  const gate = repo ? await readGateConfig(storeRoot(repo)) : null;
  emit(
    {
      ready: options['disable-review-gate'] ? null : true,
      workspaceRoot: repo,
      gate,
      message: text,
    },
    text,
    options.json,
  );
}

async function showResult(root, id, json) {
  const selected = await selectJob(root, id);
  const output = await result(root, selected.id);
  const job = await jobSnapshot(root, await selectJob(root, selected.id));
  emit({ job, output: output.text, failed: output.failed }, output.text, json);
  if (output.failed) process.exitCode = 1;
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

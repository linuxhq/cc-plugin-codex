#!/usr/bin/env node
import { help, parseCommand } from './lib/args.mjs';
import { checkSetup } from './lib/claude.mjs';
import { repositoryRoot } from './lib/git.mjs';
import {
  cancelJob,
  launchBackground,
  prepareJob,
  result,
  status,
} from './lib/jobs.mjs';
import { storeRoot } from './lib/store.mjs';
import { executeJob } from './lib/worker.mjs';

async function main() {
  const options = parseCommand(process.argv.slice(2));
  if (options.command === 'help') return console.log(help);
  if (options.command === 'setup') return console.log(await checkSetup());
  const repo = await repositoryRoot(process.cwd());
  const root = storeRoot(repo);
  if (options.command === 'status')
    return console.log(await status(root, options.id));
  if (options.command === 'cancel')
    return console.log(await cancelJob(root, options.id));
  if (options.command === 'result') return showResult(root, options.id);
  const job = await prepareJob(repo, root, options);
  if (!job) return console.log('No changes to review in the selected scope.');
  if (options.background) {
    await launchBackground(root, job);
    console.log(
      [
        `Review started: ${job.id}`,
        `Use $claude:status ${job.id} or $claude:result ${job.id}.`,
      ].join('\n'),
    );
    return;
  }
  console.error(`Review started: ${job.id}`);
  await executeJob(root, job.id);
  await showResult(root, job.id);
}

async function showResult(root, id) {
  const output = await result(root, id);
  console.log(output.text);
  if (output.failed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(
    error.code === 'ENOENT'
      ? `Required executable or file not found: ${error.path ?? error.message}`
      : error.message,
  );
  process.exitCode = 1;
}

import { executeJob } from './lib/worker.mjs';

const [root, id] = process.argv.slice(2);
try {
  const job = await executeJob(root, id);
  process.exitCode = job.state === 'completed' ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

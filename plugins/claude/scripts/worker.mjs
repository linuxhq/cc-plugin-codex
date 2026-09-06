import { executeJob } from './lib/worker.mjs';

const [root, id] = process.argv.slice(2);
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const prompt = input ? JSON.parse(input) : undefined;
  const job = await executeJob(root, id, { prompt });
  process.exitCode = job.state === 'completed' ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

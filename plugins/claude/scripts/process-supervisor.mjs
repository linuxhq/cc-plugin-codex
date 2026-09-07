import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasGroupMembers } from './lib/process-group.mjs';
import { forwardUntilBoundary } from './lib/output-boundary.mjs';

const [directory, command, ...args] = process.argv.slice(2);
const nonce = randomUUID();
const marker = `\0${nonce}\0`;
const stop = () => process.kill(-process.pid, 'SIGKILL');
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;

  stopping = true;
  setTimeout(stop, 2000);
});
// Until completion is delivered, loss of the worker stops the entire group.
process.once('disconnect', stop);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./process-runner.mjs', import.meta.url)),
    nonce,
    command,
    ...args,
  ],
  { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
);
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
const output = Promise.all([
  forwardUntilBoundary(child.stdout, process.stdout, marker),
  forwardUntilBoundary(child.stderr, process.stderr, marker),
]);
const result = new Promise((resolve) => {
  let received = false;
  child.once('message', (message) => {
    received = true;
    resolve(message);
  });
  child.once('disconnect', () => {
    if (!received) stop();
  });
});
child.once('error', stop);
child.once('exit', () => complete().catch(stop));

async function complete() {
  if (stopping) return;

  const completion = await result;
  await output;
  if (stopping) return;

  const helpers = hasGroupMembers(process.pid);
  if (helpers && directory)
    writeFileSync(join(directory, 'helper-pid'), String(process.pid), {
      mode: 0o600,
    });

  process.removeListener('disconnect', stop);
  process.once('disconnect', () => {
    if (!helpers || !directory) return stop();

    watchHelpers();
  });
  process.send({ type: 'complete', code: completion.code });
}

function watchHelpers() {
  const timer = setInterval(() => {
    if (!existsSync(directory) || existsSync(join(directory, 'session-ended')))
      return stop();

    if (!hasGroupMembers(process.pid)) {
      clearInterval(timer);
      rmSync(join(directory, 'helper-pid'), { force: true });
    }
  }, 500);
}

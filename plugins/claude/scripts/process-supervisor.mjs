import { spawn } from 'node:child_process';

// This process owns the reviewer's process group. IPC disconnect also fires
// when the worker is killed with SIGKILL, where exit handlers cannot run.
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
const disconnected = () => {
  if (process.platform === 'win32') child.kill('SIGKILL');
  else process.kill(-process.pid, 'SIGKILL');
};
process.once('disconnect', disconnected);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  process.removeListener('disconnect', disconnected);
  if (process.connected) process.disconnect();
});
child.once('close', (code) => {
  process.removeListener('disconnect', disconnected);
  process.exitCode = code ?? 1;
  if (process.connected) process.disconnect();
});

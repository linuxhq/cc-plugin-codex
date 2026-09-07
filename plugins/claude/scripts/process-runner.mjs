import { spawn } from 'node:child_process';

// Both markers follow every byte written by Claude, even if helpers retain
// these descriptors. IPC alone cannot order completion against output pipes.
const [nonce, command, ...args] = process.argv.slice(2);
const marker = `\0${nonce}\0`;
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.once('error', (error) => console.error(error.message));
child.once('close', async (code) => {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise((resolve) => stream.write(marker, resolve)),
    ),
  );
  process.send({ code: code ?? 1 }, () => process.disconnect());
});

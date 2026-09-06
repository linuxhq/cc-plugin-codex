import { spawn } from 'node:child_process';

// Use argument arrays so repository content never enters a shell.
export function runProcess(command, args, options = {}) {
  const {
    input,
    signal,
    timeout = 30_000,
    maxBytes = 4 * 1024 * 1024,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let failure;
    let killTimer;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      terminate(child, 'SIGTERM');
      killTimer = setTimeout(() => terminate(child, 'SIGKILL'), 1000);
    };
    const receive = (stream) => (chunk) => {
      if (stream !== 'stdout' || options.captureStdout !== false)
        size += Buffer.byteLength(chunk);
      if (size > maxBytes)
        return stop(new Error('Subprocess output exceeds limit.'));
      if (stream === 'stdout') {
        try {
          options.onStdout?.(chunk);
        } catch (error) {
          return stop(error);
        }
        if (options.captureStdout !== false) stdout += chunk;
      } else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', receive('stdout'));
    child.stderr.setEncoding('utf8').on('data', receive('stderr'));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stop(error);
    });
    const abort = () => stop(new Error('Review cancelled.'));
    const timer =
      timeout === null
        ? null
        : setTimeout(() => stop(new Error('Subprocess timed out.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (error, code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(failure, code));
    child.stdin.end(input);
  });
}

function terminate(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

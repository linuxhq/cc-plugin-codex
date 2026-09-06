import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../plugins/cc-plugin-codex/scripts/lib/process.mjs';

test('reports missing executable without hanging', async () => {
  await assert.rejects(runProcess('/no/such/executable', []), {
    code: 'ENOENT',
  });
});

test('times out and terminates a process that ignores SIGTERM', async () => {
  const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);";
  await assert.rejects(
    runProcess(process.execPath, ['-e', script], {
      timeout: 300,
    }),
    /timed out/,
  );
});

test('stops excessive output', async () => {
  const script = "process.stdout.write('x'.repeat(2048));";
  await assert.rejects(
    runProcess(process.execPath, ['-e', script], {
      maxBytes: 1024,
    }),
    /output exceeds limit/,
  );
});

test('supports cancellation before launch', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
      signal,
    }),
    /cancelled/,
  );
});

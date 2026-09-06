import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';

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

test('streaming output does not accumulate in the capture buffer', async () => {
  let bytes = 0;
  const result = await runProcess(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(8 * 1024 * 1024))"],
    {
      maxBytes: 1024,
      captureStdout: false,
      onStdout(chunk) {
        bytes += Buffer.byteLength(chunk);
      },
    },
  );
  assert.equal(bytes, 8 * 1024 * 1024);
  assert.equal(result.stdout, '');
  assert.equal(result.code, 0);
});

test('a stream consumer failure terminates its child', async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      ['-e', "setInterval(() => process.stdout.write('chunk'), 10)"],
      {
        captureStdout: false,
        onStdout() {
          throw new Error('Consumer failed');
        },
      },
    ),
    /Consumer failed/,
  );
});

test('a review without a deadline can still be cancelled', async () => {
  const controller = new AbortController();
  const pending = runProcess(
    process.execPath,
    ['-e', "process.stdout.write('ready'); setInterval(() => {}, 100)"],
    {
      timeout: null,
      signal: controller.signal,
      onStdout() {
        controller.abort();
      },
    },
  );
  await assert.rejects(pending, /cancelled/);
});

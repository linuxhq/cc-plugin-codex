import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventually } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('supervisor escalates direct SIGTERM', async (t) => {
  const supervisor = fileURLToPath(
    new URL(
      '../plugins/claude/scripts/process-supervisor.mjs',
      import.meta.url,
    ),
  );
  const child = spawn(
    process.execPath,
    [
      supervisor,
      process.execPath,
      '-e',
      `process.on('SIGTERM', () => {});
       console.log('ready');
       setInterval(() => {}, 100);`,
    ],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
  );
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }

    await exited;
  });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  await eventually(() => child.signalCode !== null || child.exitCode !== null);
  assert.equal((await exited).signal, 'SIGKILL');
});

test('cancellation stops descendants after their parent exits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'claude-cancel-test-'));
  const path = join(root, 'activity.json');
  let pid;
  const controller = new AbortController();
  const descendant = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    setInterval(() => fs.writeFileSync(process.argv[1], JSON.stringify({
      pid: process.pid, time: Date.now()
    })), 25);
  `;
  const parent = `
    require('node:child_process').spawn(process.execPath,
      ['-e', ${JSON.stringify(descendant)}, process.argv[1]],
      { stdio: 'ignore' });
    setInterval(() => {}, 100);
  `;
  const run = runProcess(process.execPath, ['-e', parent, path], {
    supervise: true,
    signal: controller.signal,
    timeout: null,
  }).catch((error) => error);
  t.after(async () => {
    controller.abort();
    await run;
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }

    await rm(root, { recursive: true, force: true });
  });
  await eventually(async () => {
    try {
      pid = JSON.parse(await readFile(path, 'utf8')).pid;
      return pid;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;

      throw error;
    }
  });
  controller.abort();
  assert.match((await run).message, /cancelled/);
  const stopped = await readFile(path, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await readFile(path, 'utf8'), stopped);
});

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

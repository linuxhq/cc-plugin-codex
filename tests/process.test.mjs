import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventually } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import * as boundary from '../plugins/claude/scripts/lib/output-boundary.mjs';

for (const failure of ['end', 'close', 'error']) {
  test(`output boundary rejects premature ${failure}`, async () => {
    const source = new PassThrough();
    const destination = new PassThrough();
    destination.resume();
    const pending = boundary.forwardUntilBoundary(
      source,
      destination,
      '\0completion-token\0',
    );
    const rejected = assert.rejects(pending, /boundary|broken pipe/);
    source.write('Partial result\0completion');
    if (failure === 'end') source.end();
    else
      source.destroy(
        failure === 'error' ? new Error('broken pipe') : undefined,
      );

    await rejected;
  });
}

test('fragmented output boundaries drain helper output', async () => {
  const source = new PassThrough();
  const destination = new PassThrough({ highWaterMark: 1 });
  const marker = '\0completion-token\0';
  let output = '';
  destination.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  const pending = boundary.forwardUntilBoundary(source, destination, marker);
  const expected = 'é😀\0completing\nComplete result\n';
  const input = Buffer.from(expected + marker + 'Helper output');
  for (const byte of input) source.write(Buffer.from([byte]));

  await pending;
  source.end('More helper output');
  assert.equal(output, expected);
});

test('supervised completion preserves output and exit status', async () => {
  let bytes = 0;
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write('é'.repeat(4 * 1024 * 1024));
    process.stderr.write('detail'.repeat(1024 * 1024));
    process.exitCode = 7;
  `,
    ],
    {
      supervise: true,
      captureStdout: false,
      maxBytes: Infinity,
      onStdout(chunk) {
        bytes += Buffer.byteLength(chunk);
      },
    },
  );
  assert.equal(result.code, 7);
  assert.equal(bytes, 8 * 1024 * 1024);
  assert.equal(result.stderr, 'detail'.repeat(1024 * 1024));
});

for (const repeat of [false, true]) {
  test(`supervisor preserves SIGTERM grace (repeat: ${repeat})`, async (t) => {
    const supervisor = fileURLToPath(
      new URL(
        '../plugins/claude/scripts/process-supervisor.mjs',
        import.meta.url,
      ),
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' +
          encodeURIComponent(`
        if (process.argv[1]?.endsWith('/process-supervisor.mjs')) {
          process.on('SIGTERM', () => process.send({ type: 'signal' }));
        }
      `),
        supervisor,
        '',
        process.execPath,
        '-e',
        `process.on('SIGTERM', () => {});
       console.log('ready');
       process.stdin.once('data', () => console.log('tail output'));
       setInterval(() => {}, 100);`,
      ],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
    );
    const exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    t.after(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }

      await exited;
    });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const signalled = new Promise((resolve) => child.once('message', resolve));
    const start = Date.now();
    child.kill('SIGTERM');
    await signalled;
    if (repeat) child.kill('SIGTERM');

    child.stdin.write('flush');
    await eventually(
      () => child.signalCode !== null || child.exitCode !== null,
    );
    assert.equal((await exited).signal, 'SIGKILL');
    assert.match(output, /tail output/);
    assert.ok(Date.now() - start >= 1800, 'Preserves the two-second grace');
  });
}

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

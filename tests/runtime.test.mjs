import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { join } from 'node:path';
import { fingerprint } from '../plugins/claude/scripts/lib/git.mjs';
import {
  createJob,
  jobPath,
  loadJob,
  pruneJobs,
} from '../plugins/claude/scripts/lib/store.mjs';
import { fixture, extractId, eventually, cli } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

for (const failure of [
  'end',
  'error',
  'stalled-ipc',
  'stopped-supervisor',
  'failure-sigterm',
  'complete-close',
]) {
  test(`supervisor handles ${failure} with retained helpers`, async (t) => {
    const f = await fixture(t);
    const preload = join(f.root, 'break-boundary.mjs');
    const activity = join(f.root, 'helper.json');
    const server = createServer();
    let connection;
    const disconnected = new Promise((resolve) => {
      server.once('connection', (socket) => {
        connection = socket;
        socket.resume();
        socket.once('end', resolve);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    f.cleanup(async () => {
      connection?.end('stop');
      server.close();
    });
    await writeFile(
      preload,
      `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      if (${failure === 'stalled-ipc'} &&
          process.argv[1]?.endsWith('/process-supervisor.mjs')) {
        process.send = () => false;
      }
      if (${failure === 'failure-sigterm'}) {
        const schedule = globalThis.setTimeout;
        globalThis.setTimeout = (callback, ms, ...args) => {
          if (ms !== 1000) return schedule(callback, ms, ...args);
          return schedule(() => {
            console.error('Test failure deadline fired');
            callback(...args);
          }, 3000);
        };
      }
      const { spawn } = cp;
      cp.spawn = (...args) => {
        const child = spawn(...args);
        if (args[1]?.[0]?.endsWith('/process-supervisor.mjs')) {
          const cleanup = () => {
            console.error('Test emergency supervisor cleanup');
            process.kill(-child.pid, 'SIGKILL');
          };
          const timer = setTimeout(cleanup, 10_000);
          child.once('exit', () => clearTimeout(timer));
          if (${failure === 'complete-close'}) {
            child.once('message', (message) => {
              if (message.type === 'complete')
                process.kill(-child.pid, 'SIGKILL');
            });
          }
          if (${failure === 'stopped-supervisor'}) {
            child.once('message', (message) => {
              if (message.type === 'error') child.kill('SIGSTOP');
            });
          }
        }
        if (${failure !== 'complete-close'} &&
            args[1]?.[0]?.endsWith('/process-runner.mjs')) {
          const stream = child.stdout;
          const { emit } = stream;
          stream.emit = (event, ...values) => {
            if (event === 'data' && String(values[0]).includes('\\0')) {
              return emit.call(stream,
                ${JSON.stringify(failure === 'end' ? 'end' : 'error')},
                new Error('Broken output pipe'));
            }
            return emit.call(stream, event, ...values);
          };
        }
        return child;
      };
      syncBuiltinESMExports();
    `,
    );
    const response = await f.run(
      ['review', '--scope', 'working-tree', '--json'],
      {
        NODE_OPTIONS: `--import=${preload}`,
        FAKE_CLAUDE_HELPER_ACTIVITY: activity,
        FAKE_CLAUDE_HELPER_STDIO: 'both',
        FAKE_CLAUDE_HELPER_PORT: String(server.address().port),
      },
    );
    assert.equal(
      response.code,
      failure === 'complete-close' ? 0 : 1,
      response.stdout + response.stderr,
    );
    assert.doesNotMatch(
      response.stderr,
      /timed out|Test emergency|Test failure deadline/,
    );
    assert.ok(response.stdout, response.stderr);
    const report = JSON.parse(response.stdout);
    assert.equal(
      report.job.state,
      failure === 'complete-close' ? 'completed' : 'failed',
    );
    if (failure === 'complete-close')
      assert.match(report.output, /Example finding/);
    else if (failure === 'stalled-ipc')
      assert.match(report.job.error, /Supervisor exited unexpectedly/);
    else
      assert.match(
        report.job.error,
        failure === 'end'
          ? /Output stream ended before its completion boundary/
          : /Broken output pipe/,
      );

    assert.ok(connection, 'Helper connected before the failure');
    await Promise.race([
      disconnected,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Helper survived')),
          5000,
        );
        disconnected.then(() => clearTimeout(timer));
      }),
    ]);
  });
}

test('final log failure preserves the completed result', async (t) => {
  const f = await fixture(t);
  const preload = join(f.root, 'fail-final-log.mjs');
  await writeFile(
    preload,
    `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { appendFileSync } = fs;
    fs.appendFileSync = (path, data, ...args) => {
      if (String(path).endsWith('/worker.log') &&
          data.includes('Final output\\n')) {
        throw new Error('Injected final log failure');
      }
      return appendFileSync(path, data, ...args);
    };
    syncBuiltinESMExports();
  `,
  );
  const response = await f.run(['review', '--scope', 'working-tree'], {
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.notEqual(response.code, 0);
  assert.match(response.stderr, /Injected final log failure/);
  const result = await f.run(['result', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.job.state, 'completed');
  assert.ok(report.job.finishedAt);
  assert.match(report.output, /Example finding/);
});

for (const mode of ['activity', 'fail', 'terminal']) {
  test(`session cleanup waits for finalized ${mode} output`, async (t) => {
    const f = await fixture(t);
    const preload = join(f.root, 'drain-progress.mjs');
    const observed = join(f.root, 'observed.json');
    const hook = fileURLToPath(
      new URL(
        '../plugins/claude/scripts/session-lifecycle-hook.mjs',
        import.meta.url,
      ),
    );
    await writeFile(
      preload,
      `
      import fs from 'node:fs/promises';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const { writeFile, rename } = fs;
      const { spawn } = cp;
      let release;
      const closed = new Promise((resolve) => { release = resolve; });
      cp.spawn = (...args) => {
        const child = spawn(...args);
        if (args[1]?.[0]?.endsWith('/process-supervisor.mjs')) {
          child.once('disconnect', () => setImmediate(release));
        }
        return child;
      };
      fs.writeFile = async (path, ...args) => {
        if (String(path).endsWith('/heartbeat')) await closed;
        return writeFile(path, ...args);
      };
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (!/review-[a-f0-9-]{36}\\.json$/.test(to)) return;
        const job = JSON.parse(await fs.readFile(to, 'utf8'));
        if (!(job.output || job.error) ||
            ${mode === 'terminal' ? '!job.finishedAt' : 'job.finishedAt'}) {
          return;
        }
        await writeFile(${JSON.stringify(observed)}, JSON.stringify(job));
        const hook = ${JSON.stringify(hook)};
        const child = spawn(process.execPath, [hook, 'SessionEnd'], {
          env: { ...process.env, NODE_OPTIONS: '' },
          stdio: ['pipe', 'ignore', 'inherit'],
        });
        child.stdin.end(JSON.stringify({
          cwd: job.repo, session_id: job.sessionId,
        }));
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error('Hook failed'));
          });
        });
      };
      syncBuiltinESMExports();
    `,
    );
    const response = await f.run(['rescue', '--json', 'inspect'], {
      NODE_OPTIONS: `--import=${preload}`,
      FAKE_CLAUDE_MODE: mode,
    });
    const interim = JSON.parse(
      await readFile(observed, 'utf8').catch((error) => {
        throw new Error(response.stdout + response.stderr, { cause: error });
      }),
    );
    assert.equal(interim.state, mode === 'terminal' ? 'completed' : 'running');
    assert.equal(
      response.code,
      mode === 'fail' ? 1 : 0,
      response.stdout + response.stderr,
    );
    assert.doesNotMatch(response.stdout + response.stderr, /ENOENT/);
    const report = JSON.parse(response.stdout);
    assert.equal(report.job.state, mode === 'fail' ? 'failed' : 'completed');
    assert.ok(report.job.finishedAt);
    assert.match(
      mode === 'fail' ? report.job.error : report.output,
      mode === 'fail' ? /Provider unavailable/ : /Example finding/,
    );
    await assert.rejects(access(report.job.logFile), { code: 'ENOENT' });
  });
}

for (const action of ['cancel', 'session-end', 'worker-death']) {
  test(`inspection children stop after ${action}`, async (t) => {
    const f = await fixture(t);
    const activity = join(f.root, 'inspection-activity.json');
    const converter = join(f.root, 'converter.mjs');
    await writeFile(
      converter,
      `
      import { writeFileSync, renameSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      setInterval(() => {
        const path = process.env.FAKE_CLAUDE_INSPECTION_ACTIVITY;
        writeFileSync(path + '.tmp', JSON.stringify({
          pid: process.pid, time: Date.now(),
        }));
        renameSync(path + '.tmp', path);
      }, 25);
    `,
    );
    await f.write('.gitattributes', '*.js diff=inspection\n');
    await f.git('add', '.');
    await f.git('commit', '-m', 'Attributes');
    await f.git(
      'config',
      'diff.inspection.textconv',
      `'${process.execPath}' '${converter}'`,
    );
    await f.write('app.js', 'changed\n');
    let pid;
    const launch = await f.run(
      ['rescue', '--background', '--json', 'inspect'],
      {
        FAKE_CLAUDE_MODE: 'inspection',
        FAKE_CLAUDE_INSPECTION_ACTIVITY: activity,
      },
    );
    assert.equal(launch.code, 0, launch.stderr);
    const id = JSON.parse(launch.stdout).job.id;
    f.cleanup(async () => {
      await f.run(['cancel', id]);
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
    await eventually(async () => {
      try {
        pid = JSON.parse(await readFile(activity)).pid;
        return pid;
      } catch (error) {
        if (error.code === 'ENOENT') return false;

        throw error;
      }
    });
    if (action === 'cancel') {
      await f.run(['cancel', id]);
      await f.run(['status', id, '--wait']);
    } else if (action === 'session-end') {
      const hook = fileURLToPath(
        new URL(
          '../plugins/claude/scripts/session-lifecycle-hook.mjs',
          import.meta.url,
        ),
      );
      const ended = await runProcess(process.execPath, [hook, 'SessionEnd'], {
        cwd: f.repo,
        env: f.env,
        input: JSON.stringify({ cwd: f.repo, session_id: 'test-session' }),
      });
      assert.equal(ended.code, 0, ended.stderr);
    } else {
      const root = join(
        f.env.CLAUDE_REVIEW_DATA_DIR,
        'jobs',
        fingerprint(f.repo).slice(0, 24),
      );
      const worker = Number(await readFile(jobPath(root, id, 'worker-pid')));
      process.kill(worker, 'SIGKILL');
    }

    await eventually(async () => {
      const before = await readFile(activity, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      return before === (await readFile(activity, 'utf8'));
    });
  });
}

test('foreground progress streams live and survives in logs', async (t) => {
  const f = await fixture(t);
  const release = join(f.root, 'release');
  let stderr = '';
  const child = spawn(process.execPath, [cli, 'rescue', 'inspect'], {
    cwd: f.repo,
    env: { ...f.env, FAKE_CLAUDE_MODE: 'held', FAKE_CLAUDE_RELEASE: release },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  f.cleanup(async () => {
    await writeFile(release, '');
    await exited;
  });
  await eventually(() => stderr.includes('[claude] Using Read.'));
  assert.equal(stdout, '');
  const id = extractId(stderr);
  const status = JSON.parse((await f.run(['status', id, '--json'])).stdout);
  assert.match(await readFile(status.job.logFile, 'utf8'), /Using Read/);
  await writeFile(release, '');
  assert.equal(await exited, 0);
  const log = await readFile(status.job.logFile, 'utf8');
  assert.match(log, /Starting Claude/);
  assert.match(log, /Final output\n.*\n\nP2 app.js/s);
  assert.equal((await stat(status.job.logFile)).mode & 0o777, 0o600);
});

test('quiet JSON and retained background activity logs', async (t) => {
  const f = await fixture(t);
  const foreground = await f.run(['rescue', '--json', 'inspect'], {
    FAKE_CLAUDE_MODE: 'activity',
  });
  assert.equal(foreground.code, 0);
  assert.equal(foreground.stderr, '');
  const foregroundJob = JSON.parse(foreground.stdout).job;
  const log = await readFile(foregroundJob.logFile, 'utf8');
  assert.match(log, /Running command: npm test/);
  assert.match(log, /Command failed: npm test\nExit code 1\nAssertion failed/);
  for (let index = 0; index < 6; index++) {
    const expected = `Activity ${index}: ` + 'detail '.repeat(50).trim();
    assert.ok(log.includes(expected));
  }

  assert.doesNotMatch(log, /PRIVATE_THINKING/);
  assert.doesNotMatch(JSON.stringify(foregroundJob.progress), /Activity 0:/);
  const launched = await f.run(['rescue', '--background', '--json', 'inspect']);
  const id = JSON.parse(launched.stdout).job.id;
  const finished = JSON.parse(
    (await f.run(['status', id, '--wait', '--json'])).stdout,
  );
  const path = finished.job.logFile;
  assert.match(await readFile(path, 'utf8'), /Using Read/);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  await pruneJobs(root, { maxCount: 0 });
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('killing a read-only worker also stops its Claude process', async (t) => {
  const f = await fixture(t);
  const worker = spawn(process.execPath, [cli, 'rescue', 'inspect'], {
    cwd: f.repo,
    env: { ...f.env, FAKE_CLAUDE_MODE: 'slow' },
    stdio: 'ignore',
  });
  let pid;
  f.cleanup(async () => {
    worker.kill('SIGKILL');
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  });
  await eventually(async () => {
    try {
      pid = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE)).pid;
      return pid;
    } catch (error) {
      if (error.code === 'ENOENT') return false;

      throw error;
    }
  });
  worker.kill('SIGKILL');
  await eventually(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;

      throw error;
    }
  });
});

test('foreground review preserves focus and leaves Git alone', async (t) => {
  const f = await fixture(t);
  const focus = 'Check $(touch injected) and `touch injected2`';
  await f.write('app.js', 'export const value = 0;\n');
  const before = await f.git('status', '--porcelain=v1');
  const run = await f.run(['adversarial-review', '--', focus]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Example finding/);
  const id = extractId(run.stdout);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE, 'utf8'));
  assert.ok(request.input.includes(focus));
  assert.match(request.input, /value = 0/);
  assert.equal(request.cwd, f.repo);
  assert.equal(await f.git('status', '--porcelain=v1'), before);
  assert.ok(!(await readdir(f.repo)).includes('injected'));
  assert.match((await f.run(['result', id])).stdout, /Example finding/);
  await f.write('app.js', 'changed after review\n');
  assert.doesNotMatch(
    (await f.run(['result', id])).stdout,
    /target has changed/,
  );
});

test('Claude execution survives more than four MiB of stderr', async (t) => {
  const f = await fixture(t);
  const run = await f.run(['rescue', '--json', 'inspect'], {
    FAKE_CLAUDE_MODE: 'large-stderr',
  });
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.job.state, 'completed');
  assert.match(result.output, /Example finding/);
});

test('explicit empty review still invokes the reviewer', async (t) => {
  const f = await fixture(t);
  const run = await f.run(['review']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Example finding/);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.match(request.input, /Inspect the target diff/);
});

test('provider failures and malformed output remain failed jobs', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  for (const mode of ['fail', 'malformed', 'null-result']) {
    const run = await f.run(['review'], { FAKE_CLAUDE_MODE: mode });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /failed/);
    assert.doesNotMatch(run.stdout, /Cannot read properties/);
    assert.match((await f.run(['result'])).stdout, /failed/);
  }
});

test('background worker completes and exposes stored results', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['review', '--background']);
  assert.equal(run.code, 0, run.stderr);
  const id = extractId(run.stdout);
  await eventually(async () => {
    return (await f.run(['status', id])).stdout.includes('completed');
  });
  assert.match((await f.run(['result', id])).stdout, /Example finding/);
  assert.match((await f.run(['cancel', id])).stderr, /No active job/);
});

test('prints and persists provider diagnostics', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['review'], { FAKE_CLAUDE_MODE: 'json-error' });
  assert.equal(run.code, 1);
  const id = extractId(run.stdout);
  const saved = await f.run(['result', id]);
  assert.equal(saved.code, 0);
  for (const output of [run.stdout, saved.stdout]) {
    assert.match(output, /failed/);
    assert.match(output, /Provider request failed/);
    assert.match(output, /Account quota exhausted/);
    assert.match(output, /Request could not complete/);
  }
});

test('cancellation stops a running background Claude process', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['review', '--background'], {
    FAKE_CLAUDE_MODE: 'slow',
  });
  const id = extractId(run.stdout);
  f.cleanup(async () => {
    await f.run(['cancel', id]);
    await eventually(async () => {
      return (await f.run(['status', id])).stdout.includes('cancelled');
    });
  });
  await eventually(async () => {
    const status = (await f.run(['status', id])).stdout;
    return (
      status.includes('Phase: investigating') && status.includes('Using Read.')
    );
  });
  const status = (await f.run(['status', id])).stdout;
  assert.match(status, /Elapsed: \d+s/);
  assert.match(status, /Last update:/);
  assert.match(status, /Progress:/);
  assert.match((await f.run(['cancel', id])).stdout, /Cancellation requested/);
  await eventually(async () => {
    return (await f.run(['status', id])).stdout.includes('cancelled');
  });
  const result = await f.run(['result', id]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /cancelled/);
  assert.doesNotMatch(result.stdout, /Example finding/);
});

test('adversarial text fallback preserves diagnostics', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['adversarial-review', '--wait'], {
    FAKE_CLAUDE_MODE: 'no-structured',
    FAKE_CLAUDE_OUTPUT: 'not JSON',
  });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /did not return valid structured JSON/);
  assert.match(run.stdout, /Raw final message/);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  const schema = JSON.parse(
    request.args[request.args.indexOf('--json-schema') + 1],
  );
  // Claude rejects the Draft 2020-12 meta-schema; use its default dialect.
  assert.equal(Object.hasOwn(schema, '$schema'), false);
  assert.deepEqual(schema.properties.verdict.enum, [
    'approve',
    'needs-attention',
  ]);
  assert.ok(request.args.includes('stream-json'));
});

test('empty successful responses show diagnostics', async (t) => {
  const f = await fixture(t);
  for (const [command, message] of [
    ['review', /completed without any stdout/],
    ['rescue', /did not return a final message/],
  ]) {
    const run = await f.run(
      command === 'rescue' ? [command, 'inspect'] : [command],
      { FAKE_CLAUDE_OUTPUT: '' },
    );
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, message);
  }
});

test('setup checks authentication without a review', async (t) => {
  const f = await fixture(t);
  const ready = await f.run(['setup']);
  assert.equal(ready.code, 0);
  assert.match(ready.stdout, /Authentication ready/);
  const missing = await f.run(['setup'], {
    FAKE_CLAUDE_MODE: 'unauthenticated',
  });
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /claude auth login/);
});

test('rejects job path traversal', async (t) => {
  const f = await fixture(t);
  const run = await f.run(['result', '../outside']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /Invalid job ID/);
});

test('focus text preserves newlines and shell syntax', async (t) => {
  const f = await fixture(t);
  const focus = 'First line\nSecond $line `literal`';
  await f.write('app.js', 'changed\n');
  const run = await f.run(['adversarial-review', '--', focus]);
  assert.equal(run.code, 0, run.stderr);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE, 'utf8'));
  assert.ok(request.input.includes('First line\nSecond $line `literal`'));
});

test('unexpected review shape preserves provider status', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['adversarial-review', '--wait'], {
    FAKE_CLAUDE_OUTPUT: '{"verdict":"approve","findings":[]}',
  });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Missing string `summary`/);
  assert.match(run.stdout, /Raw final message/);
  assert.match((await f.run(['status'])).stdout, /completed/);
});

for (const mode of ['foreground', 'background']) {
  test(`${mode} execution completes after history eviction`, async (t) => {
    const f = await fixture(t);
    const release = join(f.root, 'release');
    const root = join(
      f.env.CLAUDE_REVIEW_DATA_DIR,
      'jobs',
      fingerprint(f.repo).slice(0, 24),
    );
    const args = ['rescue', '--json', 'inspect'];
    if (mode === 'background') args.push('--background');

    const run = f.run(args, {
      FAKE_CLAUDE_MODE: 'held',
      FAKE_CLAUDE_RELEASE: release,
    });
    f.cleanup(async () => {
      await writeFile(release, '');
      await run;
    });
    let id;
    await eventually(async () => {
      const report = JSON.parse((await f.run(['status', '--json'])).stdout);
      const job = report.running?.find(
        (entry) => entry.progress.summary === 'Using Read.',
      );
      id = job?.id;
      return id && (await loadJob(root, id)).phase === job.progress.phase;
    });
    const { pid } = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
    await pruneJobs(root, { maxCount: 0 });
    await assert.rejects(loadJob(root, id), /Job not found/);
    const heartbeat = jobPath(root, id, 'heartbeat');
    const before = (await stat(heartbeat)).mtimeMs;
    await eventually(async () => (await stat(heartbeat)).mtimeMs > before);
    process.kill(pid, 0);
    await assert.rejects(loadJob(root, id), /Job not found/);
    await writeFile(release, '');
    const response = await run;
    assert.equal(response.code, 0, response.stderr);
    await eventually(async () => {
      try {
        return (await loadJob(root, id)).state === 'completed';
      } catch (error) {
        if (error.cause?.code === 'ENOENT') return false;

        throw error;
      }
    });
    const result = await f.run(['result', id, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).job.state, 'completed');
  });
}

test('foreground output survives completion eviction', async (t) => {
  const f = await fixture(t);
  const preload = join(f.root, 'prune-completion.mjs');
  await writeFile(
    preload,
    `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      await rename(from, to);
      if (!/review-[a-f0-9-]{36}\\.json$/.test(to)) return;
      const job = JSON.parse(await fs.readFile(to, 'utf8'));
      if (job.state === 'completed') await fs.rm(to);
    };
    syncBuiltinESMExports();
  `,
  );
  const response = await f.run(['rescue', '--json', 'inspect'], {
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(response.code, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.job.state, 'completed');
  assert.ok(report.output);
  const missing = await f.run(['result', report.job.id]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Job not found/);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  await assert.rejects(access(jobPath(root, report.job.id, '.')), {
    code: 'ENOENT',
  });
});

test('failed startup after eviction removes execution files', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'store');
  const job = await createJob(root, { repo: f.repo, command: 'rescue' });
  await writeFile(
    jobPath(root, job.id, 'prompt.json'),
    JSON.stringify({
      system: 'Investigate.',
      input: 'Inspect the repository.',
    }),
  );
  await pruneJobs(root, { maxCount: 0 });
  const worker = new URL(
    '../plugins/claude/scripts/worker.mjs',
    import.meta.url,
  );
  const run = await runProcess(
    process.execPath,
    [fileURLToPath(worker), root, job.id],
    {
      cwd: f.repo,
      env: f.env,
    },
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /Job not found/);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(access(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

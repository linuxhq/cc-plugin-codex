import { spawn } from 'node:child_process';
import { gateReviewTimeout } from '../plugins/claude/scripts/lib/claude.mjs';
import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createJob } from '../plugins/claude/scripts/lib/store.mjs';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { fingerprint } from '../plugins/claude/scripts/lib/git.mjs';
import { parseGateOutput } from '../plugins/claude/scripts/lib/gate.mjs';
import { eventually, extractId, fixture } from './helpers.mjs';

const plugin = fileURLToPath(new URL('../plugins/claude/', import.meta.url));
const hook = join(plugin, 'scripts/stop-review-gate-hook.mjs');

function runHook(f, input = {}, env = {}) {
  return runProcess(process.execPath, [hook], {
    cwd: f.repo,
    env: { ...f.env, ...env },
    input: JSON.stringify({
      hook_event_name: 'Stop',
      cwd: f.repo,
      session_id: 'test-session',
      turn_id: 'test-turn',
      stop_hook_active: false,
      last_assistant_message: 'Updated app.js.',
      ...input,
    }),
  });
}

test('disabled gate starts no review and creates no state', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
  await assert.rejects(readdir(f.env.CLAUDE_REVIEW_DATA_DIR), {
    code: 'ENOENT',
  });
  assert.match((await f.run(['setup'])).stdout, /gate: disabled/);
});

test('toggles persist; disable works without authentication', async (t) => {
  const f = await fixture(t);
  const before = await f.git('status', '--porcelain=v1');
  const enabled = await f.run(['setup', '--enable-review-gate']);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.match((await f.run(['setup'])).stdout, /gate: enabled/);
  const jobs = join(f.env.CLAUDE_REVIEW_DATA_DIR, 'jobs');
  const [key] = await readdir(jobs);
  assert.equal((await stat(join(jobs, key, 'gate.json'))).mode & 0o777, 0o600);
  const disabled = await f.run(['setup', '--disable-review-gate'], {
    FAKE_CLAUDE_MODE: 'unauthenticated',
  });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.match((await f.run(['setup'])).stdout, /gate: disabled/);
  assert.equal(await f.git('status', '--porcelain=v1'), before);
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('gate changes persist even when Claude is not ready', async (t) => {
  const f = await fixture(t);
  for (const mode of ['unauthenticated', 'unavailable']) {
    for (const [flag, enabled] of [
      ['--enable-review-gate', true],
      ['--disable-review-gate', false],
    ]) {
      const run = await f.run(['setup', flag, '--json'], {
        FAKE_CLAUDE_MODE: mode,
      });
      assert.equal(run.code, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.ready, false);
      assert.equal(report.gate.enabled, enabled);
      assert.match(report.message, /claude auth login|Install or repair/);
      const saved = JSON.parse((await f.run(['setup', '--json'])).stdout);
      assert.equal(saved.gate.enabled, enabled);
    }
  }
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('bundled command handles spaces and stores findings', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'export const value = 0;\n');
  const config = JSON.parse(await readFile(join(plugin, 'hooks/hooks.json')));
  // Exercise the actual command and PLUGIN_ROOT substitution, including spaces.
  const { cp } = await import('node:fs/promises');
  const installed = join(f.root, 'plugin with spaces');
  await cp(plugin, installed, { recursive: true });
  const output = await runProcess(
    '/bin/sh',
    ['-c', config.hooks.Stop[0].hooks[0].command],
    {
      cwd: f.repo,
      env: {
        ...f.env,
        PLUGIN_ROOT: installed,
        FAKE_CLAUDE_OUTPUT: JSON.stringify({
          decision: 'BLOCK',
          reason: 'Regression\nP2 app.js:1 example.',
        }),
      },
      input: JSON.stringify({
        hook_event_name: 'Stop',
        cwd: f.repo,
        session_id: 'test-session',
        turn_id: 'test-turn',
        last_assistant_message: 'Changed app.js $(touch injected).',
      }),
    },
  );
  assert.equal(output.code, 0, output.stderr);
  const decision = JSON.parse(output.stdout);
  assert.equal(decision.decision, 'block');
  const id = extractId(decision.reason);
  assert.equal(
    decision.reason,
    'Claude stop-time review found issues that still need fixes before ' +
      'ending the session.\n\nRegression\n\n' +
      `Full review: $claude:result ${id}`,
  );
  assert.match((await f.run(['result', id])).stdout, /P2 app.js:1 example/);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.ok(request.input.includes('$(touch injected)'));
  assert.ok(
    request.input.includes(
      'Only direct edits made in that specific turn count.',
    ),
  );
  assert.equal(request.cwd, f.repo);
  assert.ok(!(await readdir(f.repo)).includes('injected'));
  assert.match((await f.run(['status', id])).stdout, /stop-review-gate/);
});

test('clean checkout still runs the response review', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(f, {}, { FAKE_CLAUDE_MODE: 'fail' });
  assert.equal(output.code, 0);
  assert.equal(JSON.parse(output.stdout).decision, undefined);
  assert.match(JSON.parse(output.stdout).systemMessage, /could not complete/);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.match(request.input, /Updated app.js/);
});

test('ALLOW passes for a checkout with changes', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'changed\n');
  const output = await runHook(
    f,
    {},
    {
      FAKE_CLAUDE_OUTPUT: JSON.stringify({
        decision: 'ALLOW',
        reason: 'No blocking issue found.',
      }),
    },
  );
  assert.equal(output.code, 0);
  assert.deepEqual(JSON.parse(output.stdout), {});
  assert.match((await f.run(['result'])).stdout, /review passed/);
});

test('continued turns skip reviews; unrelated events do not', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(
    f,
    { stop_hook_active: true },
    {
      FAKE_CLAUDE_OUTPUT: JSON.stringify({
        decision: 'BLOCK',
        reason: 'Still needs fixing',
      }),
    },
  );
  assert.equal(JSON.parse(output.stdout).decision, undefined);
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
  for (const hook_event_name of ['UserPromptSubmit', 'SessionStart']) {
    assert.deepEqual(
      JSON.parse((await runHook(f, { hook_event_name })).stdout),
      {},
    );
  }
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('review failures report notices without blocking', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'changed\n');
  for (const env of [
    { FAKE_CLAUDE_MODE: 'fail' },
    { FAKE_CLAUDE_MODE: 'malformed' },
    { FAKE_CLAUDE_OUTPUT: 'Looks good' },
  ]) {
    const output = await runHook(f, {}, env);
    assert.equal(output.code, 0);
    const decision = JSON.parse(output.stdout);
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /could not complete/);
  }
});

test('gate settings are per worktree, shared by subdirectories', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'changed\n');
  const worktree = join(f.root, 'other worktree');
  await f.git('worktree', 'add', '-b', 'other', worktree);
  assert.deepEqual(
    JSON.parse((await runHook(f, { cwd: worktree })).stdout),
    {},
  );
  const subdir = join(f.repo, 'nested');
  await mkdir(subdir);
  const output = await runHook(
    f,
    { cwd: subdir },
    {
      FAKE_CLAUDE_OUTPUT: JSON.stringify({
        decision: 'BLOCK',
        reason: 'Test issue',
      }),
    },
  );
  assert.equal(JSON.parse(output.stdout).decision, 'block');
});

test('gate preserves diagnostics from both streams', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'changed\n');
  const output = await runHook(f, {}, { FAKE_CLAUDE_MODE: 'json-error' });
  const decision = JSON.parse(output.stdout);
  assert.equal(decision.decision, undefined);
  assert.match(decision.systemMessage, /Provider request failed/);
  assert.match(decision.systemMessage, /Account quota exhausted/);
  assert.match(decision.systemMessage, /Request could not complete/);
  const saved = await f.run(['result', extractId(decision.systemMessage)]);
  assert.equal(saved.code, 0);
  assert.match(saved.stdout, /Provider request failed/);
});

test('non-Git directories skip and plain setup works', async (t) => {
  const f = await fixture(t);
  await rm(join(f.repo, '.git'), { recursive: true });
  assert.equal(JSON.parse((await runHook(f)).stdout).decision, undefined);
  assert.equal((await f.run(['setup'])).code, 0);
  assert.equal((await f.run(['setup', '--enable-review-gate'])).code, 1);
});

test('cancellation stops the gate and returns feedback', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'changed\n');
  const pending = runHook(f, {}, { FAKE_CLAUDE_MODE: 'slow' });
  const id = await eventually(async () => {
    const status = (await f.run(['status'])).stdout;
    return status.includes('running') && extractId(status);
  });
  await f.run(['cancel', id]);
  const output = JSON.parse((await pending).stdout);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /cancelled/);
});

test('corrupt configuration surfaces feedback and can be reset', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const jobs = join(f.env.CLAUDE_REVIEW_DATA_DIR, 'jobs');
  const [key] = await readdir(jobs);
  await writeFile(join(jobs, key, 'gate.json'), '{"enabled":"false"}');
  const output = JSON.parse((await runHook(f)).stdout);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /Invalid review gate configuration/);
  assert.equal((await f.run(['setup', '--disable-review-gate'])).code, 0);
  assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
});

test('decision parser requires a structured, nonempty verdict', () => {
  for (const output of [
    '',
    'ALLOW: fine',
    'null',
    '{}',
    '{"decision":"BLOCK","reason":""}',
    '{"decision":"ALLOW","reason":"fine","extra":true}',
  ]) {
    const parsed = parseGateOutput(output);
    assert.equal(parsed.decision, undefined);
    assert.match(parsed.systemMessage, /invalid decision/);
  }
  assert.deepEqual(
    parseGateOutput('{"decision":"ALLOW","reason":"No findings."}'),
    {},
  );
  assert.equal(
    parseGateOutput('{"decision":"BLOCK","reason":"Regression"}').decision,
    'block',
  );
});

test('unavailable CLI reports setup guidance without blocking', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(f, {}, { FAKE_CLAUDE_MODE: 'unavailable' });
  const decision = JSON.parse(output.stdout);
  assert.equal(decision.decision, undefined);
  assert.match(decision.systemMessage, /Run \$claude:setup/);
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('reporting turns use the response review', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await f.write('app.js', 'OLD_CONTENT_SENTINEL\n');
  const message = 'The setup check completed. No code was edited.';
  const output = await runHook(
    f,
    { last_assistant_message: message },
    {
      FAKE_CLAUDE_OUTPUT: JSON.stringify({
        decision: 'ALLOW',
        reason: 'Reporting only',
      }),
    },
  );
  assert.deepEqual(JSON.parse(output.stdout), {});
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.ok(request.input.includes(message));
  assert.match(request.input, /Pure status, setup, or reporting output/);
  assert.ok(!request.input.includes('OLD_CONTENT_SENTINEL'));
});

test('gate running-job notices prefer the hook session', async (t) => {
  const f = await fixture(t);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  const envJob = await createJob(root, {
    repo: f.repo,
    command: 'review',
    sessionId: 'test-session',
  });
  const hookJob = await createJob(root, {
    repo: f.repo,
    command: 'review',
    sessionId: 'hook-session',
  });
  const notice = JSON.parse(
    (
      await runHook(f, {
        session_id: 'hook-session',
      })
    ).stdout,
  );
  assert.ok(notice.systemMessage.includes(hookJob.id));
  assert.ok(!notice.systemMessage.includes(envJob.id));
  const fallback = JSON.parse((await runHook(f, { session_id: '' })).stdout);
  assert.ok(fallback.systemMessage.includes(envJob.id));
  const empty = JSON.parse(
    (
      await runHook(f, {
        session_id: 'no-jobs-session',
      })
    ).stdout,
  );
  assert.deepEqual(empty, {});
});

test('automatic review leaves time inside the hook deadline', async () => {
  const config = JSON.parse(await readFile(join(plugin, 'hooks/hooks.json')));
  assert.ok(
    gateReviewTimeout + 60_000 < config.hooks.Stop[0].hooks[0].timeout * 1000,
  );
});

test('terminating the hook terminates its running reviewer', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const child = spawn(process.execPath, [hook], {
    cwd: f.repo,
    env: { ...f.env, FAKE_CLAUDE_MODE: 'slow' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: f.repo }));
  const pid = await eventually(async () => {
    try {
      return JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE)).pid;
    } catch {
      return false;
    }
  });
  child.kill('SIGTERM');
  await closed;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.match(JSON.parse(output).systemMessage, /cancelled/);
});

test('missing or failed inspection cannot be reported as ALLOW', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  for (const mode of ['no-inspection', 'inspection-failed']) {
    const output = await runHook(
      f,
      {},
      {
        FAKE_CLAUDE_MODE: mode,
        FAKE_CLAUDE_OUTPUT: JSON.stringify({
          decision: 'ALLOW',
          reason: 'Fine',
        }),
      },
    );
    const decision = JSON.parse(output.stdout);
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /could not complete/);
    assert.doesNotMatch(decision.systemMessage, /review passed/);
  }
});

test('failed inspection preserves non-approval verdicts', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  for (const verdict of ['BLOCK', 'INCOMPLETE']) {
    const output = await runHook(
      f,
      {},
      {
        FAKE_CLAUDE_MODE: 'inspection-failed',
        FAKE_CLAUDE_OUTPUT: JSON.stringify({
          decision: verdict,
          reason: 'Specific evidence and explanation.',
        }),
      },
    );
    const decision = JSON.parse(output.stdout);
    assert.match(
      decision.reason || decision.systemMessage,
      /Specific evidence/,
    );
    assert.equal(decision.decision, verdict === 'BLOCK' ? 'block' : undefined);
  }
});

test('SKIP needs no inspection and renders readable results', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(
    f,
    { last_assistant_message: 'Status only.' },
    {
      FAKE_CLAUDE_MODE: 'no-inspection',
      FAKE_CLAUDE_OUTPUT: JSON.stringify({
        decision: 'SKIP',
        reason: 'No code edits need review.',
      }),
    },
  );
  assert.deepEqual(JSON.parse(output.stdout), {});
  const result = (await f.run(['result'])).stdout;
  assert.match(result, /# Claude Automatic Review/);
  assert.match(result, /No code edits/);
  assert.doesNotMatch(result, /"decision":/);
});

test('continued turns respect disabled gates and non-repos', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    JSON.parse((await runHook(f, { stop_hook_active: true })).stdout),
    {},
  );
  await rm(join(f.repo, '.git'), { recursive: true });
  const output = JSON.parse(
    (await runHook(f, { stop_hook_active: true })).stdout,
  );
  assert.doesNotMatch(output.systemMessage, /continued Stop/);
});

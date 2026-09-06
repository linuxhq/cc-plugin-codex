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
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
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

test('failed authentication does not enable the gate', async (t) => {
  const f = await fixture(t);
  const run = await f.run(['setup', '--enable-review-gate'], {
    FAKE_CLAUDE_MODE: 'unauthenticated',
  });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /claude auth login/);
  assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
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
        FAKE_CLAUDE_OUTPUT: 'BLOCK: Regression\nP2 app.js:1 example.',
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
      `ending the session: Regression\nReview job: ${id}`,
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
  assert.equal(JSON.parse(output.stdout).decision, 'block');
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
      FAKE_CLAUDE_OUTPUT: 'ALLOW: No blocking issue found.',
    },
  );
  assert.equal(output.code, 0);
  assert.deepEqual(JSON.parse(output.stdout), {});
  assert.match((await f.run(['result'])).stdout, /ALLOW:/);
});

test('continued turns run reviews; unrelated events do not', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(
    f,
    { stop_hook_active: true },
    {
      FAKE_CLAUDE_OUTPUT: 'BLOCK: Still needs fixing',
    },
  );
  assert.equal(JSON.parse(output.stdout).decision, 'block');
  await rm(f.env.FAKE_CLAUDE_CAPTURE);
  for (const hook_event_name of ['UserPromptSubmit', 'SessionStart']) {
    assert.deepEqual(
      JSON.parse((await runHook(f, { hook_event_name })).stdout),
      {},
    );
  }
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('failed or malformed reviews never pass', async (t) => {
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
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /disable-review-gate/);
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
      FAKE_CLAUDE_OUTPUT: 'BLOCK: Test issue',
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
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /Provider request failed/);
  assert.match(decision.reason, /Account quota exhausted/);
  assert.match(decision.reason, /Request could not complete/);
  const saved = await f.run(['result', extractId(decision.reason)]);
  assert.equal(saved.code, 1);
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
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /cancelled/);
});

test('corrupt configuration surfaces feedback and can be reset', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const jobs = join(f.env.CLAUDE_REVIEW_DATA_DIR, 'jobs');
  const [key] = await readdir(jobs);
  await writeFile(join(jobs, key, 'gate.json'), '{"enabled":"false"}');
  const output = JSON.parse((await runHook(f)).stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Invalid review gate configuration/);
  assert.equal((await f.run(['setup', '--disable-review-gate'])).code, 0);
  assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
});

test('decision parser matches upstream ALLOW and BLOCK prefixes', () => {
  for (const output of [
    '',
    'BLOCK:',
    'Here is my review\nALLOW: fine',
    '```\nALLOW: fine\n```',
  ]) {
    assert.equal(parseGateOutput(output).decision, 'block');
  }
  assert.deepEqual(parseGateOutput('ALLOW:'), {});
  assert.deepEqual(parseGateOutput('ALLOW: No findings.\r\nLimitations.'), {});
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
      FAKE_CLAUDE_OUTPUT: 'ALLOW: Reporting only',
    },
  );
  assert.deepEqual(JSON.parse(output.stdout), {});
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.ok(request.input.includes(message));
  assert.match(request.input, /Pure status, setup, or reporting output/);
  assert.ok(!request.input.includes('OLD_CONTENT_SENTINEL'));
});

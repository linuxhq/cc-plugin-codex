import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { parseGateOutput } from '../plugins/claude/scripts/lib/gate.mjs';
import { fingerprint } from '../plugins/claude/scripts/lib/git.mjs';
import { createJob } from '../plugins/claude/scripts/lib/store.mjs';
import { extractId, fixture } from './helpers.mjs';

const hook = fileURLToPath(
  new URL(
    '../plugins/claude/scripts/stop-review-gate-hook.mjs',
    import.meta.url,
  ),
);

function runHook(f, input = {}, env = {}) {
  return runProcess(process.execPath, [hook], {
    cwd: f.repo,
    env: { ...f.env, FAKE_CLAUDE_OUTPUT: 'ALLOW: No findings.', ...env },
    input: JSON.stringify({
      hook_event_name: 'Stop',
      cwd: f.repo,
      session_id: 'test-session',
      last_assistant_message: 'Updated app.js.',
      ...input,
    }),
  });
}

test('disabled gate starts no review and persists toggles', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
  await assert.rejects(readdir(f.env.CLAUDE_REVIEW_DATA_DIR), {
    code: 'ENOENT',
  });
  for (const mode of ['unauthenticated', 'unavailable']) {
    for (const [flag, enabled] of [
      ['--enable-review-gate', true],
      ['--disable-review-gate', false],
    ]) {
      const run = await f.run(['setup', flag, '--json'], {
        FAKE_CLAUDE_MODE: mode,
      });
      const report = JSON.parse(run.stdout);
      assert.equal(report.ready, false);
      assert.equal(report.gate.enabled, enabled);
      assert.equal(
        JSON.parse((await f.run(['setup', '--json'])).stdout).gate.enabled,
        enabled,
      );
    }
  }

  assert.equal((await f.git('status', '--porcelain')).trim(), '');
});

test('upstream gate accepts only ALLOW and BLOCK', () => {
  assert.deepEqual(parseGateOutput('ALLOW: Fine\nDetails'), {});
  assert.equal(parseGateOutput('BLOCK: Regression\nDetails').decision, 'block');
  for (const value of ['', 'SKIP: Nothing', 'INCOMPLETE: Failed', '{}']) {
    const output = parseGateOutput(value);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /unexpected answer/);
  }
});

test('gate preserves findings and literal response text', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(
    f,
    { last_assistant_message: 'Changed app.js $(touch injected).' },
    { FAKE_CLAUDE_OUTPUT: 'BLOCK: Regression\nP2 app.js:1 example.' },
  );
  const decision = JSON.parse(output.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /Regression/);
  assert.doesNotMatch(decision.reason, /P2 app.js/);
  const id = extractId(decision.reason);
  assert.match((await f.run(['result', id])).stdout, /P2 app.js:1 example/);
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.match(request.input, /\$\(touch injected\)/);
  assert.match(request.input, /Only direct edits made in that specific turn/);
  assert.ok(!request.args.includes('--json-schema'));
  assert.ok(!(await readdir(f.repo)).includes('injected'));
});

test('reporting turns can allow without tool inspection', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const output = await runHook(f, {
    last_assistant_message: 'Setup completed. No edits.',
  });
  assert.deepEqual(JSON.parse(output.stdout), {});
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.match(
    request.input,
    /return ALLOW immediately and do no further work/,
  );
  assert.match((await f.run(['result'])).stdout, /ALLOW: No findings/);
});

test('unchanged and continued turns still run review', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  for (const input of [{}, {}, { stop_hook_active: true }]) {
    assert.deepEqual(JSON.parse((await runHook(f, input)).stdout), {});
    assert.ok(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
    await rm(f.env.FAKE_CLAUDE_CAPTURE);
  }

  const state = join(f.env.CLAUDE_REVIEW_DATA_DIR, 'jobs');
  const [key] = await readdir(state);
  assert.ok(!(await readdir(join(state, key))).includes('gate-snapshot.json'));
});

test('failures block; unavailable Claude provides guidance', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  for (const mode of ['fail', 'malformed']) {
    const output = JSON.parse(
      (await runHook(f, {}, { FAKE_CLAUDE_MODE: mode })).stdout,
    );
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /could not complete/);
  }

  const unavailable = JSON.parse(
    (await runHook(f, {}, { FAKE_CLAUDE_MODE: 'unavailable' })).stdout,
  );
  assert.equal(unavailable.decision, undefined);
  assert.match(unavailable.systemMessage, /Run \$claude:setup/);
});

test('unrelated hooks do not start reviews', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  for (const hook_event_name of ['UserPromptSubmit', 'SessionStart']) {
    assert.deepEqual(
      JSON.parse((await runHook(f, { hook_event_name })).stdout),
      {},
    );
  }

  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('running-job notices use the hook session', async (t) => {
  const f = await fixture(t);
  const root = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
  );
  const job = await createJob(root, {
    repo: f.repo,
    command: 'review',
    sessionId: 'hook-session',
  });
  const notice = JSON.parse(
    (await runHook(f, { session_id: 'hook-session' })).stdout,
  );
  assert.ok(notice.systemMessage.includes(job.id));
  assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
});

test('completed gates discard prompts and retain metrics', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await runHook(f);
  const job = JSON.parse((await f.run(['result', '--json'])).stdout).job;
  assert.equal(job.prompt, undefined);
  assert.equal(job.metrics.durationMs, 123);
  assert.equal(job.metrics.costUsd, 0.01);
});

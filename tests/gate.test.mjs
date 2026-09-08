import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('empty successful gate output still blocks', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const run = await runHook(f, {}, { FAKE_CLAUDE_OUTPUT: '' });
  assert.equal(JSON.parse(run.stdout).decision, 'block');
});

test('gate accepts a single final verdict after explanatory prose', () => {
  assert.deepEqual(
    parseGateOutput(
      'The previous turn made no edits.\n\nALLOW: Nothing to gate.',
    ),
    {},
  );
  const blocked = parseGateOutput('Found a regression.\n\nBLOCK: Handle null.');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /Handle null/);
});

test('potential BLOCK verdicts anywhere preserve their reason', () => {
  for (const token of [
    'BLOCK:',
    'BLOCK',
    '(BLOCK)',
    'BLOCK!',
    '**BLOCK:**',
    '**BLOCK**:',
    '- **BLOCK**:',
    '> BLOCK:',
    '1. BLOCK:',
    '# BLOCK:',
    '| BLOCK:',
    '• BLOCK:',
    '=> BLOCK:',
    'Final verdict: BLOCK:',
    'Actually, BLOCK:',
    '2) note - BLOCK:',
    '`BLOCK`:',
  ]) {
    for (const output of [
      `${token} Regression`,
      `ALLOW: Fine\n${token} Regression`,
      `ALLOW: Fine. ${token} Regression`,
      `\`\`\`text\n${token} Regression\n\`\`\`\nALLOW: Fine`,
    ]) {
      const decision = parseGateOutput(output);
      assert.equal(decision.decision, 'block', output);
      assert.match(decision.reason, /Regression/, output);
      assert.doesNotMatch(decision.reason, /unexpected answer/, output);
    }
  }
});

test('gate rejects ambiguous or unsupported ALLOW verdicts', () => {
  for (const output of [
    'Explanation\n  ALLOW: Fine',
    'Explanation\nALLOW: Fine\nALLOW: Fine',
    'ALLOW: Fine. ALLOW: Fine again',
    'ALLOW: Fine. ALLOW',
    'ALLOW: Fine\n(ALLOW)',
    'ALLOW: Fine\n**ALLOW**',
    'Explanation\n> ALLOW: Fine',
    'Explanation\n```text\nALLOW: Fine\n```',
    'Explanation\n```text\nALLOW: Fine',
    'Explanation\n~~~text\nALLOW: Fine',
    'Explanation\nALLOW: Fine\nMore explanation',
    'Explanation\nALLOW:',
    'Explanation only',
  ]) {
    const decision = parseGateOutput(output);
    assert.equal(decision.decision, 'block', output);
    assert.match(decision.reason, /unexpected answer/, output);
  }
});

test('decorated and lowercase verdicts cannot authorize a pass', () => {
  for (const verdict of [
    '- ALLOW: Fine',
    '> ALLOW: Fine',
    '**ALLOW:** Fine',
    '1. ALLOW: Fine',
    'allow: Fine',
    'Allow: Fine',
    'ALLOW',
    '(ALLOW)',
    '# ALLOW: Fine',
    'Final verdict: ALLOW: Fine',
    'ALLOW : Fine',
  ]) {
    for (const output of [verdict, `Explanation\n${verdict}`]) {
      const decision = parseGateOutput(output);
      assert.equal(decision.decision, 'block', output);
      assert.match(decision.reason, /unexpected answer/, output);
    }
  }
});

test('ordinary prose and identifiers are not conflicting verdicts', () => {
  for (const detail of [
    'BLOCK_SIZE: 64',
    'ALLOWLIST: configured',
    'UNBLOCK: complete',
    'some_BLOCK: complete',
    '__BLOCK__',
    'ALLOW_LIST: configured',
    '__ALLOW__',
    'Nothing here to block: proceeding.',
    'Reason to allow: no edits.',
    'Block: mixed case prose; Allow: mixed case prose.',
  ]) {
    assert.deepEqual(parseGateOutput(`ALLOW: Fine\n${detail}`), {}, detail);
  }
});

test('fenced examples do not hide later conflicting verdicts', () => {
  for (const example of [
    '```text\nALLOW: Example\n  BLOCK: Example\n```',
    '~~~diff\n- BLOCK: Example\n~~~',
    '````text\n```\nBLOCK: Example\n````',
  ]) {
    assert.equal(parseGateOutput(`ALLOW: Fine\n${example}`).decision, 'block');
    assert.equal(
      parseGateOutput(`ALLOW: Fine\n${example}\nBLOCK: Regression`).decision,
      'block',
    );
    assert.equal(parseGateOutput(`${example}\nALLOW: Fine`).decision, 'block');
  }
});

test('unclosed fences cannot hide conflicts after a first-line ALLOW', () => {
  for (const example of [
    '```text\nBLOCK: Regression',
    '~~~text\nBLOCK: Regression',
    '```text\nBLOCK: Regression\n```end',
    '````text\nBLOCK: Regression\n```',
    '```text\nBLOCK: Regression\n~~~',
  ]) {
    const decision = parseGateOutput(`ALLOW: Fine\n${example}`);
    assert.equal(decision.decision, 'block', example);
    assert.ok(decision.reason, example);
  }
});

test('quoted and prose verdict tokens conservatively block', () => {
  for (const detail of [
    'No reason to BLOCK this change.',
    'The example uses the word ALLOW.',
    'The test quotes "ALLOW: Fine" and "BLOCK: Regression".',
  ]) {
    assert.equal(parseGateOutput(`ALLOW: Fine\n${detail}`).decision, 'block');
  }
});

test('first-line ALLOW permits code examples without verdict words', () => {
  assert.deepEqual(
    parseGateOutput('ALLOW: Fine\n```js\nconst value = 1;\n```'),
    {},
  );
});

test('first-line BLOCK preserves its reason despite later verdicts', () => {
  for (const detail of [
    'ALLOW: Fine',
    '- allow: n/a',
    'The failing assertion expected "ALLOW: Fine".',
    '```text\nALLOW: Example\n```',
  ]) {
    const decision = parseGateOutput(`BLOCK: Handle null.\n${detail}`);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /Handle null\.$/);
    assert.doesNotMatch(decision.reason, /unexpected answer/);
  }
});

test('canonical BLOCK reasons take priority over scanned examples', () => {
  for (const output of [
    'The example says BLOCK: Example.\nBLOCK: Handle null.',
    '```text\nBLOCK: Example.\n```\nBLOCK: Handle null.',
    'BLOCK: Handle null.\nBLOCK: Later reason.',
  ]) {
    const decision = parseGateOutput(output);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /Handle null\.$/);
    assert.doesNotMatch(decision.reason, /Example|Later reason/);
  }
});

test('noncanonical final blocks preserve the first detected reason', () => {
  for (const last of ['block: Later.', '**BLOCK:** Later.']) {
    const decision = parseGateOutput(`The example says BLOCK: First.\n${last}`);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /First\.$/);
  }

  assert.match(parseGateOutput('BLOCK:\nDetails').reason, /BLOCK:\nDetails$/);
});

test('unreadable settings use the upstream disabled default', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const path = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
    'gate.json',
  );
  for (const text of ['not JSON', '{}', 'null']) {
    await writeFile(path, text);
    assert.deepEqual(JSON.parse((await runHook(f)).stdout), {});
  }

  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('malformed hook input reports an advisory error', async (t) => {
  const f = await fixture(t);
  const run = await runProcess(process.execPath, [hook], {
    cwd: f.repo,
    env: f.env,
    input: 'invalid JSON',
  });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.trim());
});

test('gate input has no adapter-specific 2 MiB cap', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const response = 'x'.repeat(2 * 1024 * 1024 + 1);
  const run = await runHook(f, { last_assistant_message: response });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {});
  const capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.ok(capture.input.includes(response));
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
  for (const mode of ['fail', 'malformed', 'unauthenticated']) {
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

test('session limits block like other upstream review failures', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  const run = await runHook(f, {}, { FAKE_CLAUDE_MODE: 'session-limit' });
  assert.equal(run.code, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not complete/);
  assert.match(output.reason, /resets 3:50pm/);
  assert.equal(output.systemMessage, undefined);
  const result = JSON.parse((await f.run(['result', '--json'])).stdout);
  assert.equal(result.job.state, 'failed');
  assert.match(result.output, /session limit/);
  const status = JSON.parse(
    (await f.run(['status', '--all', '--json'])).stdout,
  );
  assert.equal(status.latestFinished.id, result.job.id);
  assert.deepEqual(status.recent, []);
  assert.equal(status.config.stopReviewGate, true);
  // A later user turn can still receive a real review and blocking findings.
  const later = await runHook(
    f,
    {},
    {
      FAKE_CLAUDE_OUTPUT: "BLOCK: You've hit your session limit in app.js.",
    },
  );
  assert.equal(JSON.parse(later.stdout).decision, 'block');
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
  assert.ok(job.claudeSessionId);
  const candidate = JSON.parse(
    (await f.run(['rescue-resume-candidate', '--json'])).stdout,
  );
  assert.equal(candidate.jobId, job.id);
  const resumed = await f.run([
    'rescue',
    '--resume',
    '--json',
    'inspect findings',
  ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(
    JSON.parse(resumed.stdout).job.claudeSessionId,
    job.claudeSessionId,
  );
});

test('gate can review a workspace outside Git', async (t) => {
  const f = await fixture(t);
  const setup = await f.run(['setup', '--cwd', f.root, '--enable-review-gate']);
  assert.equal(setup.code, 0, setup.stderr);
  const hook = await runHook(f, { cwd: f.root });
  assert.deepEqual(JSON.parse(hook.stdout), {});
  const result = await f.run(['result', '--cwd', f.root, '--json']);
  assert.equal(JSON.parse(result.stdout).job.command, 'stop-review-gate');
});

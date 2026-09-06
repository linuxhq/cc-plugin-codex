import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fixture, extractId, eventually } from './helpers.mjs';

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
  for (const mode of ['fail', 'malformed']) {
    const run = await f.run(['review'], { FAKE_CLAUDE_MODE: mode });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /failed/);
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
    return status.includes('Phase: reading') && status.includes('Using Read.');
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

test('adversarial schema is enforced and missing output fails', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['adversarial-review', '--wait'], {
    FAKE_CLAUDE_MODE: 'no-structured',
  });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /no structured output/);
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

test('invalid adversarial JSON fails with raw diagnostics', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'changed\n');
  const run = await f.run(['adversarial-review', '--wait'], {
    FAKE_CLAUDE_OUTPUT: '{"verdict":"approve","findings":[]}',
  });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Missing summary/);
  assert.match(run.stdout, /Raw final message/);
  assert.match((await f.run(['status'])).stdout, /failed/);
});

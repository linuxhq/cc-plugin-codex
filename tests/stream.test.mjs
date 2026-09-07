import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewStream } from '../plugins/claude/scripts/lib/stream.mjs';
import { parseResult } from '../plugins/claude/scripts/lib/claude.mjs';

test('repeated session IDs do not reset ongoing progress', () => {
  const phases = [];
  const stream = reviewStream(
    (update) => phases.push(update.phase),
    () => phases.push('starting'),
  );
  for (const event of [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write' }],
      },
    },
    { type: 'result', subtype: 'success', result: 'Done' },
  ]) {
    stream.write(JSON.stringify({ ...event, session_id: 'session' }) + '\n');
  }

  assert.equal(parseResult(stream.finish()), 'Done');
  assert.deepEqual(phases, ['starting', 'reviewing', 'editing']);
});

test('large result events survive arbitrary stream boundaries', () => {
  const result = 'x'.repeat(16 * 1024 * 1024 + 1);
  const wire = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result,
  });
  const stream = reviewStream();
  stream.write(wire.slice(0, -1));
  stream.write(wire.slice(-1) + '\n');
  assert.equal(parseResult(stream.finish()), result);
});

test('fragmented events preserve the result and exclude thinking', () => {
  const updates = [];
  const stream = reviewStream((progress) => updates.push(progress));
  const events = [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'PRIVATE_THINKING' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Partial output' },
      },
    },
    { type: 'result', subtype: 'success', result: 'Final review é' },
  ];
  const wire = events.map((event) => JSON.stringify(event)).join('\r\n');
  for (let offset = 0; offset < wire.length; offset += 7)
    stream.write(wire.slice(offset, offset + 7));

  assert.equal(parseResult(stream.finish()), 'Final review é');
  assert.ok(updates.some((update) => update.phase === 'investigating'));
  assert.ok(updates.some((update) => update.phase === 'finalizing'));
  assert.ok(!JSON.stringify(updates).includes('PRIVATE_THINKING'));
});

test('partial assistant output cannot substitute for a final result', () => {
  const stream = reviewStream();
  stream.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ALLOW: looks good' }] },
    }),
  );
  assert.throws(() => parseResult(stream.finish()), /did not complete/);
});

test('structured output uses the validated field even with empty text', () => {
  const data = {
    verdict: 'approve',
    summary: 'Safe.',
    findings: [],
    next_steps: [],
  };
  const stream = reviewStream();
  stream.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: data,
    }) + '\n',
  );
  assert.deepEqual(
    JSON.parse(
      parseResult(stream.finish(), {
        structured: true,
      }),
    ),
    data,
  );
});

test('schema retries and nonzero exits remain failures', () => {
  const event = {
    type: 'result',
    subtype: 'error_max_structured_output_retries',
    errors: ['Schema retries exhausted'],
  };
  const stream = reviewStream();
  stream.write(JSON.stringify(event));
  assert.throws(
    () => parseResult(stream.finish(), { structured: true }),
    /Schema retries exhausted/,
  );
  assert.throws(
    () =>
      parseResult(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: '',
          structured_output: {},
        }),
        { structured: true, code: 1, stderr: 'Provider failed' },
      ),
    /Provider failed/,
  );
});

test('plain provider errors survive an initialized stream', () => {
  const stream = reviewStream();
  stream.write('{"type":"system","subtype":"init"}\nQuota exhausted\n');
  assert.throws(
    () => parseResult(stream.finish(), { code: 1 }),
    /Quota exhausted/,
  );
});

test('long failure diagnostics preserve the original cause', () => {
  for (const raw of [
    'ROOT CAUSE: authentication rejected\n' + 'detail\n'.repeat(2000),
    JSON.stringify('ROOT CAUSE: ' + 'x'.repeat(10000)),
    JSON.stringify({ error: 'ROOT CAUSE', detail: 'x'.repeat(10000) }),
  ]) {
    const stream = reviewStream();
    stream.write(raw + '\n');
    const output = stream.finish();
    assert.equal(output, raw.trim());
    assert.throws(() => parseResult(output, { code: 1 }), /ROOT CAUSE/);
  }
});

test('untyped output cannot substitute for a result event', () => {
  const stream = reviewStream();
  stream.write('{"subtype":"success","result":"ALLOW: looks good"}\n');
  assert.throws(() => parseResult(stream.finish()));
  stream.write('{"type":"result","subtype":"success","result":"Done"}');
  assert.equal(parseResult(stream.finish()), 'Done');
});

test('multiple final results fail instead of choosing a verdict', () => {
  const stream = reviewStream();
  const line = '{"type":"result","subtype":"success","result":"OK"}\n';
  assert.throws(() => stream.write(line + line), /multiple result/);
});

test('tool activity distinguishes work phases', () => {
  const updates = [];
  const stream = reviewStream((update) => updates.push(update));
  for (const [name, input] of [
    ['Edit', {}],
    ['Write', {}],
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'git status' }],
    ['Read', {}],
  ]) {
    stream.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name, input }] },
      }) + '\n',
    );
  }

  assert.deepEqual(
    updates.map((update) => update.phase),
    ['editing', 'editing', 'verifying', 'running', 'investigating'],
  );
});

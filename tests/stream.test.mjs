import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewStream } from '../plugins/claude/scripts/lib/stream.mjs';
import { parseResult } from '../plugins/claude/scripts/lib/claude.mjs';

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
  assert.ok(updates.some((update) => update.phase === 'reading'));
  assert.ok(updates.some((update) => update.phase === 'writing'));
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

test('multiple final results fail instead of choosing a verdict', () => {
  const stream = reviewStream();
  const line = '{"type":"result","subtype":"success","result":"OK"}\n';
  assert.throws(() => stream.write(line + line), /multiple result/);
});

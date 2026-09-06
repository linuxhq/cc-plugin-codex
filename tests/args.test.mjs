import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand } from '../plugins/claude/scripts/lib/args.mjs';

test('review defaults preserve Claude model and effort configuration', () => {
  const options = parseCommand(['review']);
  assert.equal(options.scope, 'auto');
  assert.equal(options.background, false);
  assert.equal(options.model, undefined);
  assert.equal(options.effort, undefined);
});

test('adversarial focus and model values survive parsing verbatim', () => {
  const options = parseCommand([
    'adversarial-review',
    '--model',
    'provider/custom-model',
    '--effort',
    'high',
    '--',
    'check $(touch nope) and `commands`',
  ]);
  assert.equal(options.focus, 'check $(touch nope) and `commands`');
  assert.equal(options.model, 'provider/custom-model');
  assert.equal(options.effort, 'high');
});

for (const args of [
  ['review', '--background', '--wait'],
  ['review', '--scope', 'staged'],
  ['review', 'custom focus'],
  ['review', '--focus-file', 'focus.txt'],
  ['review', '--effort', 'extreme'],
  ['review', '--unknown'],
  ['review', '--base', ''],
  ['review', '--model', '  '],
  ['status', '--wait'],
  ['status', 'one', 'two'],
  ['status', 'review-ab', '--wait', '--timeout-ms', 'NaN'],
  ['status', 'review-ab', '--wait', '--timeout-ms', '-1'],
  ['status', 'review-ab', '--wait', '--poll-interval-ms', '0'],
  ['status', '--cwd', ''],
  ['result', '--wait'],
  ['setup', 'extra'],
  ['setup', '--enable-review-gate', '--disable-review-gate'],
  ['setup', '--enable-review-gate', 'extra'],
  ['setup', '--unknown'],
]) {
  test(`rejects invalid arguments: ${args.join(' ')}`, () => {
    assert.throws(() => parseCommand(args));
  });
}

test('setup accepts either review gate toggle', () => {
  assert.deepEqual(parseCommand(['setup']), { command: 'setup' });
  for (const flag of ['enable-review-gate', 'disable-review-gate']) {
    assert.equal(parseCommand(['setup', `--${flag}`])[flag], true);
  }
});

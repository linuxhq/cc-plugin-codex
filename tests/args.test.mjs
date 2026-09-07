import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand } from '../plugins/claude/scripts/lib/args.mjs';

test('explicit boolean values follow upstream semantics', () => {
  const task = parseCommand([
    'rescue',
    '--write',
    '--write=false',
    '--background=false',
    '--wait=true',
    '--json=false',
    '--resume=false',
    '--fresh',
    'inspect',
  ]);
  assert.equal(task.write, false);
  assert.equal(task.background, false);
  assert.equal(task.wait, true);
  assert.equal(task.json, false);
  assert.equal(task.resume, false);
  assert.equal(task.fresh, true);
  assert.equal(parseCommand(['status', '--all=0']).all, true);
  assert.equal(parseCommand(['status', '--wait=false']).wait, false);
  assert.equal(
    parseCommand(['setup', '--enable-review-gate=false'])['enable-review-gate'],
    false,
  );
});

test('option values and passthrough text are never boolean-normalized', () => {
  const task = parseCommand([
    'rescue',
    '--model',
    '--write=false',
    '--',
    '--json=false',
  ]);
  assert.equal(task.model, '--write=false');
  assert.equal(task.focus, '--json=false');
  assert.equal(task.write, false);
  assert.equal(task.json, undefined);
  assert.equal(parseCommand(['rescue', '-m', 'name=a=b']).model, 'name=a=b');
});

test('upstream option spellings select directory, model, and mode', () => {
  for (const cwdFlag of ['--cwd', '-cwd', '-C', '--C']) {
    for (const modelFlag of ['--model', '-model', '-m', '--m']) {
      const task = parseCommand([
        'rescue',
        cwdFlag,
        '/tmp/target',
        modelFlag,
        'sonnet',
        '-write',
        'fix',
      ]);
      assert.equal(task.cwd, '/tmp/target');
      assert.equal(task.model, 'sonnet');
      assert.equal(task.write, true);
      assert.equal(task.focus, 'fix');
    }
  }

  const review = parseCommand(['review', '--C=/tmp/target', '--m=sonnet']);
  assert.equal(review.cwd, '/tmp/target');
  assert.equal(review.model, 'sonnet');
  assert.throws(() => parseCommand(['rescue', '-model']));
});

test('inline values use upstream splitting at an extra equals sign', () => {
  const task = parseCommand([
    'rescue',
    '--write',
    '--write=false=extra',
    '--json=false=extra',
    '--model=sonnet=extra',
    'inspect',
  ]);
  assert.equal(task.write, false);
  assert.equal(task.json, false);
  assert.equal(task.model, 'sonnet');
  assert.equal(task.focus, 'inspect');
  assert.equal(parseCommand(['rescue', '--write=true=extra']).write, true);
  assert.equal(parseCommand(['rescue', '--write=']).write, true);
});

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
    '--',
    'check $(touch nope) and `commands`',
  ]);
  assert.equal(options.focus, 'check $(touch nope) and `commands`');
  assert.equal(options.model, 'provider/custom-model');
});

for (const args of [
  ['review', '--background', '--wait'],
  ['review', '--scope', 'staged'],
  ['review', 'custom focus'],
  ['review', '--focus-file', 'focus.txt'],
  ['review', '--effort', 'minimal'],
  ['review', '--unknown'],
  ['status', '--wait'],
  ['status', 'one', 'two'],
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

test('upstream model and effort normalization preserves defaults', () => {
  for (const command of ['review', 'adversarial-review', 'rescue']) {
    assert.equal(parseCommand([command, '--model', '  ']).model, undefined);
    assert.equal(
      parseCommand([command, '--model', ' custom/model ']).model,
      'custom/model',
    );
  }

  assert.equal(parseCommand(['rescue', '--effort', ' HIGH ']).effort, 'high');
  assert.equal(parseCommand(['rescue', '--effort', ' ']).effort, undefined);
  assert.equal(parseCommand(['review', '--base', '']).base, '');
  assert.equal(
    parseCommand(['review', '--base', 'main', '--scope', 'staged']).base,
    'main',
  );
});

test('status accepts upstream timing controls without requiring wait', () => {
  for (const value of ['0', '-1', 'NaN', '1.5']) {
    const options = parseCommand([
      'status',
      '--timeout-ms',
      value,
      '--poll-interval-ms',
      value,
    ]);
    assert.equal(options['timeout-ms'], value);
    assert.equal(options['poll-interval-ms'], value);
  }
});

test('setup and correctness review reject unsupported flags', () => {
  assert.throws(() => parseCommand(['setup', '--install']));
  for (const command of ['review']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.throws(() => parseCommand([command, '--effort', effort]));
    }
  }
});

test('task and focus text preserve unknown options in upstream order', () => {
  for (const command of ['rescue', 'adversarial-review']) {
    const options = parseCommand([
      command,
      'Explain',
      '--force',
      '-xyz',
      '--setting=a=b',
      '--constructor',
      '--model',
      'sonnet',
      'behavior',
      '--',
      '--model',
      'literal',
    ]);
    assert.equal(options.model, 'sonnet');
    assert.equal(
      options.focus,
      'Explain --force -xyz --setting=a=b --constructor behavior ' +
        '--model literal',
    );
    assert.equal(Object.hasOwn(options, 'force'), false);
    assert.throws(() => parseCommand([command, '--model']));
  }

  const review = parseCommand(['adversarial-review', '--effort', 'high']);
  assert.equal(review.focus, '--effort high');
  assert.equal(review.effort, undefined);
});

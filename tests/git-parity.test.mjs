import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { collectReview, git } from '../plugins/claude/scripts/lib/git.mjs';
import * as repo from '../plugins/claude/scripts/lib/repository-tools.mjs';
import { fixture } from './helpers.mjs';

test('auto scope matches upstream for submodule dirtiness', async (t) => {
  const f = await fixture(t);
  const sub = await fixture(t);
  await f.git(
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    sub.repo,
    'module',
  );
  await f.git('commit', '-am', 'Add submodule');
  await f.git('checkout', '-b', 'feature');
  await f.write('app.js', 'parent branch sentinel\n');
  await f.git('commit', '-am', 'Parent change');
  await f.write('module/untracked.txt', 'nested untracked sentinel\n');
  assert.match(await f.git('status', '--porcelain'), /module/);
  const target = await collectReview(f.repo, { scope: 'auto' });
  assert.equal(target.scope, 'branch');
  assert.equal(target.base, 'main');
  assert.match(target.context, /parent branch sentinel/);
  assert.equal(
    (await collectReview(f.repo, { scope: 'working-tree' })).scope,
    'working-tree',
  );
  await f.write('module/app.js', 'tracked submodule sentinel\n');
  const dirty = await collectReview(f.repo, { scope: 'auto' });
  assert.equal(dirty.scope, 'working-tree');
  assert.match(dirty.context, /tracked submodule sentinel/);
});

test('collection and inspection preserve Git text conversion', async (t) => {
  const f = await fixture(t);
  await f.write('.gitattributes', '*.js diff=fixture\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Attributes');
  const converter = join(f.root, 'convert');
  await writeFile(converter, '#!/bin/sh\nprintf converted:\ncat "$1"\n', {
    mode: 0o700,
  });
  await f.git('config', 'diff.fixture.textconv', `'${converter}'`);
  await f.write('app.js', 'changed\n');
  for (const staged of [false, true]) {
    if (staged) await f.git('add', '.');

    assert.match((await collectReview(f.repo)).context, /\+converted:changed/);
    assert.match(
      await repo.inspectRepository(f.repo, { operation: 'diff', staged }),
      /\+converted:changed/,
    );
  }

  await f.git('commit', '-m', 'Change');
  assert.match(
    (await collectReview(f.repo, { base: 'HEAD~1' })).context,
    /\+converted:changed/,
  );
  assert.match(
    await repo.inspectRepository(f.repo, {
      operation: 'diff',
      base: 'HEAD~1',
    }),
    /\+converted:changed/,
  );
});

test('Git has no default deadline and honors cancellation', async (t) => {
  const f = await fixture(t);
  const fake = join(f.root, 'bin', 'git');
  await writeFile(
    fake,
    `#!${process.execPath}\n` +
      'setTimeout(() => console.log("finished"), 150);\n',
    { mode: 0o700 },
  );
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    original(callback, delay === 30_000 ? 10 : delay, ...args),
  );
  assert.match(await git(f.repo, [], { env: f.env }), /finished/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    git(f.repo, [], { env: f.env, signal: controller.signal }),
    /cancelled/,
  );
});

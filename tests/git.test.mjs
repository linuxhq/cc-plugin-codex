import assert from 'node:assert/strict';
import { readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { collectReview } from '../plugins/claude/scripts/lib/git.mjs';
import { fixture } from './helpers.mjs';

test('captures all working layers, excluding ignored files', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'export const value = 2;\n');
  await f.git('add', 'app.js');
  await f.write('app.js', 'export const value = 3;\n');
  await f.write('new file\nwith newline.js', 'untracked content\n');
  await f.write('.gitignore', 'secret.txt\n');
  await f.git('add', '.gitignore');
  await f.git('commit', '-m', 'Ignore secret');
  await f.write('app.js', 'export const value = 2;\n');
  await f.git('add', 'app.js');
  await f.write('app.js', 'export const value = 3;\n');
  await f.write('secret.txt', 'do not include');
  const target = await collectReview(f.repo, {});
  assert.match(target.context, /STAGED CHANGES/);
  assert.match(target.context, /UNSTAGED CHANGES/);
  assert.match(target.context, /value = 2/);
  assert.match(target.context, /value = 3/);
  assert.match(target.context, /untracked content/);
  assert.doesNotMatch(target.context, /do not include/);
});

test('reviews staged files before the first commit', async (t) => {
  const f = await fixture(t, { commit: false });
  await f.git('add', 'app.js');
  const target = await collectReview(f.repo, {});
  assert.match(target.context, /value = 1/);
});

test('branch review excludes base-only commits', async (t) => {
  const f = await fixture(t);
  await f.git('checkout', '-b', 'feature');
  await f.write('feature.js', 'feature change\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Feature');
  await f.git('checkout', 'main');
  await f.write('base-only.js', 'base branch only\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Base');
  await f.git('checkout', 'feature');
  const target = await collectReview(f.repo, { base: 'main' });
  assert.equal(target.scope, 'branch');
  assert.match(target.context, /feature change/);
  assert.doesNotMatch(target.context, /base branch only/);
});

test('branch review excludes dirty files and rejects bad refs', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'dirty\n');
  const target = await collectReview(f.repo, { base: 'main' });
  assert.doesNotMatch(target.context, /dirty/);
  await assert.rejects(collectReview(f.repo, { base: '--help' }));
});

test('auto reviews committed changes with a detected base', async (t) => {
  const f = await fixture(t);
  await f.git('checkout', '-b', 'feature');
  await f.write('app.js', 'feature change\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Feature');
  for (const options of [{}, { scope: 'branch' }]) {
    const target = await collectReview(f.repo, options);
    assert.equal(target.scope, 'branch');
    assert.equal(target.base, 'main');
    assert.match(target.context, /feature change/);
  }

  const working = await collectReview(f.repo, { scope: 'working-tree' });
  assert.doesNotMatch(working.context, /feature change/);
  const explicit = await collectReview(f.repo, {
    scope: 'working-tree',
    base: 'main',
  });
  assert.equal(explicit.scope, 'branch');
  assert.match(explicit.context, /feature change/);
});

test('describes symlinks without following their targets', async (t) => {
  const f = await fixture(t);
  await symlink('/outside/private-data', join(f.repo, 'link'));
  await f.write('binary.bin', Buffer.from([0, 1, 2]));
  const target = await collectReview(f.repo, {});
  assert.match(target.context, /Symlink target: \/outside\/private-data/);
  assert.match(target.context, /Binary file; contents not reviewed/);
});

test('large untracked files are omitted without saved patches', async (t) => {
  const f = await fixture(t);
  await f.write('large.txt', 'large change\n'.repeat(200_000));
  const before = await readdir(f.root);
  const target = await collectReview(f.repo);
  assert.match(target.context, /skipped: exceeds 24576 byte limit/);
  assert.ok(target.context.length < 2048);
  assert.deepEqual(await readdir(f.root), before);
});

test('large staged and branch patches use Git summaries', async (t) => {
  const f = await fixture(t);
  await f.git('checkout', '-b', 'feature');
  await f.write(
    'app.js',
    'export const item = 1;\n'.repeat(150_000) + 'TAIL\n',
  );
  await f.git('add', '.');
  const staged = await collectReview(f.repo);
  assert.equal(staged.inputMode, 'self-collect');
  assert.match(staged.context, /app.js/);
  assert.doesNotMatch(staged.context, /\+TAIL/);
  await f.git('commit', '-m', 'Large feature');
  const branch = await collectReview(f.repo, { base: 'main' });
  assert.equal(branch.inputMode, 'self-collect');
  assert.match(branch.context, /app.js/);
  assert.doesNotMatch(branch.context, /\+TAIL/);
});

test('more than two files uses summary even for tiny patches', async (t) => {
  const f = await fixture(t);
  await f.write('one', 'one');
  await f.write('two', 'two');
  await f.write('three', 'three');
  await f.git('add', '.');
  const target = await collectReview(f.repo);
  assert.equal(target.inputMode, 'self-collect');
  assert.match(target.collectionGuidance, /Use the repository inspect tool/);
});

test('inline review includes configuration changes', async (t) => {
  const f = await fixture(t);
  await f.write('.env', 'old-private-sentinel\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Secret fixture');
  await f.write('.env', 'new-private-sentinel\n');
  const target = await collectReview(f.repo, { command: 'adversarial-review' });
  assert.match(target.context, /private-sentinel/);
  const review = await collectReview(f.repo, { command: 'review' });
  assert.match(review.context, /inspect tool/);
  assert.doesNotMatch(review.context, /Git commands/);
});

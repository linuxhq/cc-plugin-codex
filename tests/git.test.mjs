import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
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

test('rejects dirty branch reviews and invalid refs', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'dirty\n');
  await assert.rejects(
    collectReview(f.repo, { base: 'main' }),
    /clean tracked/,
  );
  await assert.rejects(collectReview(f.repo, { base: '--help' }));
});

test('describes symlinks without following their targets', async (t) => {
  const f = await fixture(t);
  await symlink('/outside/private-data', join(f.repo, 'link'));
  await f.write('binary.bin', Buffer.from([0, 1, 2]));
  const target = await collectReview(f.repo, {});
  assert.match(target.context, /Symlink target: \/outside\/private-data/);
  assert.match(target.context, /Binary file; contents not reviewed/);
});

test('rejects large context without silent truncation', async (t) => {
  const f = await fixture(t);
  await f.write('large.txt', 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(collectReview(f.repo, {}), /too large/);
});

test('fingerprints detect binary content changes', async (t) => {
  const f = await fixture(t);
  await f.write('binary.bin', Buffer.from([0, 1, 2]));
  const untracked = await collectReview(f.repo, {});
  await f.write('binary.bin', Buffer.from([0, 3, 4]));
  const updated = await collectReview(f.repo, {});
  assert.notEqual(untracked.fingerprint, updated.fingerprint);
  await f.git('add', 'binary.bin');
  await f.git('commit', '-m', 'Binary');
  await f.write('binary.bin', Buffer.from([0, 5, 6]));
  const tracked = await collectReview(f.repo, {});
  await f.write('binary.bin', Buffer.from([0, 7, 8]));
  const changed = await collectReview(f.repo, {});
  assert.notEqual(tracked.fingerprint, changed.fingerprint);
});

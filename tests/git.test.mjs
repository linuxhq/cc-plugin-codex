import assert from 'node:assert/strict';
import { readFile, readdir, stat, symlink } from 'node:fs/promises';
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

test('branch review excludes dirty files and rejects bad refs', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'dirty\n');
  const target = await collectReview(f.repo, { base: 'main' });
  assert.equal(target.context, '');
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
  assert.equal(working.context, '');
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

test('large untracked files retain a complete private snapshot', async (t) => {
  const f = await fixture(t);
  const contents = 'large change é\n'.repeat(200_000) + 'FINAL_SENTINEL\n';
  await f.write('large.txt', contents);
  const options = { contextRoot: f.root };
  const target = await collectReview(f.repo, options);
  assert.equal(target.inputMode, 'file');
  assert.ok(target.context.length < 2048);
  const snapshot = await readFile(target.contextPath, 'utf8');
  assert.equal(snapshot, `UNTRACKED FILE "large.txt"\n${contents}\n`);
  assert.equal((await stat(target.contextPath)).mode & 0o777, 0o600);
  assert.equal((await stat(target.contextDirectory)).mode & 0o777, 0o700);
  const before = await readdir(f.root);
  const check = await collectReview(f.repo, {
    ...options,
    fingerprintOnly: true,
  });
  assert.equal(check.fingerprint, target.fingerprint);
  assert.deepEqual(await readdir(f.root), before);
  await f.write('large.txt', 'edited after launch\n');
  assert.equal(await readFile(target.contextPath, 'utf8'), snapshot);
  assert.notEqual(
    (await collectReview(f.repo, options)).fingerprint,
    target.fingerprint,
  );
});

test('large staged and branch patches stream without truncation', async (t) => {
  const f = await fixture(t);
  await f.git('checkout', '-b', 'feature');
  await f.write(
    'app.js',
    'export const item = 1;\n'.repeat(150_000) + 'TAIL\n',
  );
  await f.git('add', '.');
  const options = { contextRoot: f.root };
  const staged = await collectReview(f.repo, options);
  assert.equal(staged.inputMode, 'file');
  assert.match(await readFile(staged.contextPath, 'utf8'), /\+TAIL/);
  await f.git('commit', '-m', 'Large feature');
  const branch = await collectReview(f.repo, { ...options, base: 'main' });
  assert.equal(branch.inputMode, 'file');
  assert.match(await readFile(branch.contextPath, 'utf8'), /\+TAIL/);
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

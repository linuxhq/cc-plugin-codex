import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from './helpers.mjs';

test('missing Claude reports guidance and saves the gate', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, 'bin', 'claude'));
  // Keep Git available without falling through to a real Claude executable.
  const { symlink } = await import('node:fs/promises');
  await symlink('/usr/bin/git', join(f.root, 'bin', 'git'));
  const run = await f.run(['setup', '--enable-review-gate', '--json'], {
    PATH: join(f.root, 'bin'),
  });
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.missing, true);
  assert.equal(report.ready, false);
  assert.equal(report.npm.available, false);
  assert.equal(report.gate.enabled, true);
  assert.match(report.message, /https:\/\/code.claude.com\/docs\/en\/setup/);
  assert.doesNotMatch(report.message, /--install|checksum|pinned/);
});

test('setup detects npm without invoking an installer', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, 'bin', 'npm'),
    '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\necho 11.0.0\n',
    { mode: 0o700 },
  );
  const run = await f.run(['setup', '--json']);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.node.available, true);
  assert.match(report.message, /node: v/);
  assert.match(report.message, /npm: 11\.0\.0/);
  assert.deepEqual(report.npm, { available: true, version: '11.0.0' });
});

test('setup distinguishes availability from authentication', async (t) => {
  const f = await fixture(t);
  const broken = JSON.parse(
    (
      await f.run(['setup', '--json'], {
        FAKE_CLAUDE_MODE: 'unavailable',
      })
    ).stdout,
  );
  assert.equal(broken.ready, false);
  assert.equal(broken.missing, true);
  const auth = JSON.parse(
    (
      await f.run(['setup', '--json'], {
        FAKE_CLAUDE_MODE: 'unauthenticated',
      })
    ).stdout,
  );
  assert.equal(auth.ready, false);
  assert.equal(auth.missing, false);
  assert.match(auth.message, /claude auth login/);
});

test('setup readiness includes Node availability', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'bin', 'node'), '#!/bin/sh\nexit 1\n', {
    mode: 0o700,
  });
  const run = await f.run(['setup', '--json']);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.node.available, false);
  assert.match(report.message, /node: unavailable/);
});

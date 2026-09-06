import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
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
  assert.equal(report.gate.enabled, true);
  assert.match(report.message, /https:\/\/code.claude.com\/docs\/en\/setup/);
  assert.doesNotMatch(report.message, /--install|checksum|pinned/);
});

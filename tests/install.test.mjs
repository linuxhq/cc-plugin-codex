import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import {
  installClaude,
  verifyDownload,
} from '../plugins/claude/scripts/lib/install.mjs';

test('installer verifies size and checksum', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from('verified artifact');
  const artifact = {
    size: data.length,
    checksum: createHash('sha256').update(data).digest('hex'),
  };
  const path = join(f.root, 'binary');
  await verifyDownload([data.subarray(0, 3), data.subarray(3)], path, artifact);
  assert.deepEqual(await readFile(path), data);
  await assert.rejects(
    verifyDownload(
      [Buffer.from('tampered artifact')],
      join(f.root, 'tampered'),
      artifact,
    ),
    /checksum/,
  );
  await assert.rejects(
    verifyDownload([data, data], join(f.root, 'large'), artifact),
    /exceeds/,
  );
});

test('installer rejects invalid pinned downloads', async () => {
  let executed = false;
  await assert.rejects(
    installClaude({
      download: async (url, options) => {
        assert.match(
          url,
          /^https:\/\/downloads\.claude\.ai\/claude-code-releases\/2\.1\.236\//,
        );
        assert.equal(options.redirect, 'error');
        return { ok: true, body: [Buffer.from('tampered')] };
      },
      run: async () => {
        executed = true;
      },
    }),
    /checksum/,
  );
  assert.equal(executed, false);
});

test('setup does not install when Claude is already available', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['setup', '--install', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, true);
});

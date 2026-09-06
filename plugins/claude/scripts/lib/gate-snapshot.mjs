import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  readlink,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.mjs';

// Only a successfully reviewed state in this session can be reused. Bounds or
// unavailable evidence disable this optimization, never the review itself.
export async function gateSnapshot(repo) {
  try {
    const hash = createHash('sha256');
    const index = await git(repo, ['ls-files', '--stage', '-z']);
    if (/(^|\0)160000 /.test(index)) return null;
    hash.update(index);
    hash.update(await git(repo, ['rev-parse', '--verify', 'HEAD']));
    const files = (
      await git(repo, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--deduplicate',
        '-z',
      ])
    )
      .split('\0')
      .filter(Boolean);
    const budget = { bytes: 32 * 1024 * 1024, deadline: Date.now() + 5000 };
    for (const file of files) {
      hash.update(JSON.stringify(file));
      await hashFile(join(repo, file), hash, budget);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

async function hashFile(path, hash, budget) {
  if (Date.now() > budget.deadline) throw new Error('Snapshot deadline.');
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    hash.update('missing');
    return;
  }
  hash.update(String(info.mode));
  if (info.isSymbolicLink()) {
    hash.update(JSON.stringify(await readlink(path)));
    return;
  }
  if (!info.isFile()) throw new Error('Unsupported snapshot file.');
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('File changed type.');
    const content = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      budget.bytes -= chunk.length;
      if (budget.bytes < 0 || Date.now() > budget.deadline)
        throw new Error('Snapshot budget exceeded.');
      content.update(chunk);
    }
    hash.update(content.digest());
  } finally {
    await handle.close();
  }
}

export async function reuseGateSnapshot(root, sessionId, snapshot) {
  if (!sessionId || !snapshot) return false;
  try {
    const prior = JSON.parse(await readFile(join(root, 'gate-snapshot.json')));
    return prior.sessionId === sessionId && prior.snapshot === snapshot;
  } catch {
    return false;
  }
}

export async function saveGateSnapshot(root, sessionId, snapshot) {
  const path = join(root, 'gate-snapshot.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ sessionId, snapshot }), {
    mode: 0o600,
  });
  await rename(temporary, path);
}

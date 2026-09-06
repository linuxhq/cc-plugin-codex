import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fingerprint, git } from './git.mjs';
import { runProcess } from './process.mjs';
import { collectContext } from './context.mjs';

function baselinePath(root, input) {
  if (!input.session_id || !input.turn_id)
    throw new Error('Turn tracking requires session_id and turn_id.');
  return join(root, `turn-${fingerprint(input.session_id)}.json`);
}

async function readBaseline(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshotGit(repo, root, args, index, options = {}) {
  const objects = join(root, 'objects');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const original = resolve(
    repo,
    (await git(repo, ['rev-parse', '--git-path', 'objects'])).trimEnd(),
  );
  const result = await runProcess('git', ['--no-pager', ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: original,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBytes: 2 * 1024 * 1024,
    ...options,
  });
  if (result.code !== 0) throw new Error(result.stderr || 'Snapshot failed.');
  return result.stdout;
}

async function snapshot(repo, root) {
  const index = join(root, `index-${randomUUID()}`);
  const run = (args) => snapshotGit(repo, root, args, index);
  try {
    const originalIndex = resolve(
      repo,
      (await git(repo, ['rev-parse', '--git-path', 'index'])).trimEnd(),
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await copyFile(originalIndex, index);
      // Rebuild entries without copied stat data: a same-size edit can share
      // timestamps with the baseline and otherwise be mistaken for unchanged.
      const tree = (await run(['write-tree'])).trim();
      await run(['read-tree', '--empty']);
      await run(['read-tree', tree]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await run(['read-tree', '--empty']);
    }
    await run(['-c', 'core.fsmonitor=false', 'add', '-A', '--', '.']);
    return (await run(['write-tree'])).trim();
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

export async function beginTurn(repo, root, input) {
  const path = baselinePath(root, input);
  const previous = await readBaseline(path);
  // Steering prompts in the same turn must not replace its starting state.
  if (previous?.turnId === input.turn_id) return;
  const tree = await snapshot(repo, root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ turnId: input.turn_id, tree }), {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function collectTurn(repo, root, input) {
  const baseline = await readBaseline(baselinePath(root, input));
  if (!baseline || baseline.turnId !== input.turn_id) return null;
  if (!/^[a-f0-9]{40,64}$/.test(baseline.tree))
    throw new Error('Invalid turn snapshot.');
  const tree = await snapshot(repo, root);
  const captured = await collectContext(
    (write) =>
      snapshotGit(
        repo,
        root,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--full-index',
          '--unified=5',
          baseline.tree,
          tree,
          '--',
        ],
        join(root, `index-${randomUUID()}`),
        { captureStdout: false, onStdout: write },
      ),
    { contextRoot: root },
  );
  return { scope: 'turn', ...captured };
}

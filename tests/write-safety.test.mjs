import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  link,
  mkdir,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import * as guard from '../plugins/claude/scripts/lib/write-guard.mjs';
import * as edits from '../plugins/claude/scripts/lib/repository-write.mjs';
import {
  createJob,
  jobPath,
  loadJob,
} from '../plugins/claude/scripts/lib/store.mjs';
import { launchBackground } from '../plugins/claude/scripts/lib/jobs.mjs';
import { executeJob } from '../plugins/claude/scripts/lib/worker.mjs';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { readContextFile } from '../plugins/claude/scripts/lib/transfer.mjs';

async function guarded(f) {
  const root = join(f.root, 'jobs');
  const job = await createJob(root, { repo: f.repo, command: 'rescue' });
  const release = await guard.acquireWriteGuard(root, job);
  return { job, release, root };
}

test('edits back up dirty files and isolate hardlinks', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'uncommitted');
  await f.write('untracked.txt', 'untracked original');
  const outside = join(f.root, 'outside.txt');
  await writeFile(outside, 'outside original');
  await link(outside, join(f.repo, 'hardlink.txt'));
  const { job, release } = await guarded(f);
  try {
    for (const [path, expected] of [
      ['app.js', 'uncommitted'],
      ['untracked.txt', 'untracked original'],
      ['hardlink.txt', 'outside original'],
      ['new.txt', null],
    ])
      await edits.writeRepository(f.repo, job.recovery, {
        path,
        expected,
        content: 'updated',
      });
    await edits.writeRepository(f.repo, job.recovery, {
      path: 'app.js',
      expected: 'updated',
      content: 'second edit',
    });
    assert.equal(await readFile(outside, 'utf8'), 'outside original');
    const directory = join(dirname(job.recovery), 'backups');
    const records = await Promise.all(
      (await readdir(directory)).map(async (name) =>
        JSON.parse(await readFile(join(directory, name))),
      ),
    );
    assert.equal(records.length, 4);
    assert.equal(
      records.find((item) => item.path === 'app.js').text,
      'uncommitted',
    );
    assert.equal(records.find((item) => item.path === 'new.txt').text, null);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await release();
  }
});

test('writes reject unsafe paths and stale contents', async (t) => {
  const f = await fixture(t);
  await f.write('.gitignore', 'ignored.txt\n');
  await f.write('ignored.txt', 'private');
  await symlink(f.root, join(f.repo, 'escape'));
  await symlink(join(f.repo, 'app.js'), join(f.repo, 'alias'));
  const { job, release } = await guarded(f);
  try {
    for (const path of [
      '../out',
      '/tmp/out',
      'escape/out',
      'alias',
      '.env',
      '.git/config',
      '.aws/credentials',
      'ignored.txt',
      '.npmrc',
    ])
      await assert.rejects(
        edits.writeRepository(f.repo, job.recovery, {
          path,
          expected: null,
          content: 'bad',
        }),
      );
    await assert.rejects(
      edits.writeRepository(f.repo, job.recovery, {
        path: 'app.js',
        expected: 'stale',
        content: 'bad',
      }),
      /File changed/,
    );
    assert.equal(
      await readFile(join(f.repo, 'app.js'), 'utf8'),
      'export const value = 1;\n',
    );
    // No recovery means no mutation, even with otherwise valid arguments.
    await assert.rejects(
      edits.writeRepository(f.repo, null, {
        path: 'new.txt',
        expected: null,
        content: 'bad',
      }),
      /recovery/,
    );
  } finally {
    await release();
  }
});

test('stale holders cannot write or release locks', async (t) => {
  const f = await fixture(t);
  const a = await guarded(f);
  const lock = join(f.repo, '.git', 'claude-rescue.lock');
  await rm(lock);
  const b = await guarded(f);
  await assert.rejects(
    edits.writeRepository(f.repo, a.job.recovery, {
      path: 'new.txt',
      expected: null,
      content: 'bad',
    }),
    /ownership lost/,
  );
  await assert.rejects(a.release(), /ownership changed/);
  assert.equal(JSON.parse(await readFile(lock)).jobId, b.job.id);
  await assert.rejects(guarded(f), /Another write job/);
  await b.release();
});

test('Windows write mode fails before acquiring a lock', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    guard.acquireWriteGuard(f.root, { repo: f.repo }, 'win32'),
    /unsupported on Windows/,
  );
  await assert.rejects(readFile(join(f.repo, '.git', 'claude-rescue.lock')), {
    code: 'ENOENT',
  });
});

test('invalid worker prompts persist failures', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'jobs');
  const worker = fileURLToPath(
    new URL('../plugins/claude/scripts/worker.mjs', import.meta.url),
  );
  for (const payload of [undefined, '{invalid', '{}']) {
    const job = await createJob(root, { repo: f.repo, command: 'rescue' });
    if (payload !== undefined)
      await writeFile(jobPath(root, job.id, 'prompt.json'), payload);
    const result = await runProcess(process.execPath, [worker, root, job.id]);
    assert.equal(result.code, 1);
    const saved = await loadJob(root, job.id);
    assert.equal(saved.state, 'failed');
    assert.match(saved.error, /prompt delivery/);
    await assert.rejects(readFile(jobPath(root, job.id, 'prompt.json')), {
      code: 'ENOENT',
    });
  }
  const job = await createJob(root, { repo: f.repo, command: 'rescue' });
  const failed = await executeJob(root, job.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /prompt was not delivered/);
});

test('context rejects escapes and secrets', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    readContextFile('/etc/hosts', f.repo),
    /Context must be inside/,
  );
  await symlink('/etc', join(f.root, 'etc'));
  await assert.rejects(
    readContextFile(join(f.root, 'etc/hosts'), f.repo),
    /Context must be inside/,
  );
  for (const path of [
    '.aws/credentials',
    '.netrc',
    '.npmrc',
    '.config/gh/hosts.yml',
    '.kube/config',
  ]) {
    const target = join(f.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'private');
    await assert.rejects(readContextFile(target, f.repo), /Sensitive/);
  }
});

test('spawn failure removes payload and records failure', async (t) => {
  const f = await fixture(t);
  const root = join(f.root, 'jobs');
  const job = await createJob(root, {
    repo: join(f.root, 'missing'),
    command: 'rescue',
  });
  job.prompt = { system: 'Investigate', input: 'private task' };
  await assert.rejects(launchBackground(root, job));
  const saved = await loadJob(root, job.id);
  assert.equal(saved.state, 'failed');
  assert.match(saved.error, /ENOENT/);
  assert.equal(saved.prompt, undefined);
  await assert.rejects(readFile(jobPath(root, job.id, 'prompt.json')), {
    code: 'ENOENT',
  });
});

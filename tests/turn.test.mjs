import assert from 'node:assert/strict';
import { readFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from './helpers.mjs';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(
  new URL(
    '../plugins/claude/scripts/stop-review-gate-hook.mjs',
    import.meta.url,
  ),
);
async function event(f, name, turn = 'one', session = 'session') {
  const result = await runProcess(process.execPath, [hook], {
    cwd: f.repo,
    env: { ...f.env, FAKE_CLAUDE_OUTPUT: 'ALLOW: Checked changes.' },
    input: JSON.stringify({
      hook_event_name: name,
      cwd: f.repo,
      session_id: session,
      turn_id: turn,
      last_assistant_message: 'SECRET ASSISTANT MESSAGE',
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('old staged and untracked edits skip review', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'old staged edit\n');
  await f.git('add', '.');
  await f.write('old.txt', 'old untracked edit\n');
  await f.run(['setup', '--enable-review-gate']);
  const status = await f.git('status', '--porcelain=v1');
  const index = await f.git('diff', '--cached');
  await event(f, 'UserPromptSubmit');
  assert.deepEqual(await event(f, 'Stop'), {});
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
  assert.equal(await f.git('status', '--porcelain=v1'), status);
  assert.equal(await f.git('diff', '--cached'), index);
});

test('turn diff includes committed edits and excludes old edits', async (t) => {
  const f = await fixture(t);
  await f.write('old.txt', 'OLDER_CHANGE_SENTINEL\n');
  await f.run(['setup', '--enable-review-gate']);
  await event(f, 'UserPromptSubmit');
  await f.write('app.js', 'export const value = 2;\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Current work');
  assert.deepEqual(await event(f, 'Stop'), {});
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.match(request.input, /\+export const value = 2/);
  assert.doesNotMatch(request.input, /OLDER_CHANGE_SENTINEL|SECRET ASSISTANT/);
  await event(f, 'UserPromptSubmit', 'two');
  const before = await readFile(f.env.FAKE_CLAUDE_CAPTURE, 'utf8');
  assert.deepEqual(await event(f, 'Stop', 'two'), {});
  assert.equal(await readFile(f.env.FAKE_CLAUDE_CAPTURE, 'utf8'), before);
});

test('baselines survive steering and are isolated by session', async (t) => {
  const f = await fixture(t);
  await f.run(['setup', '--enable-review-gate']);
  await event(f, 'UserPromptSubmit');
  await f.write('app.js', 'changed\n');
  await event(f, 'UserPromptSubmit');
  assert.match(
    (await event(f, 'Stop', 'one', 'other')).systemMessage,
    /no starting snapshot/,
  );
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
  assert.deepEqual(await event(f, 'Stop'), {});
  assert.match(
    JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE)).input,
    /\+changed/,
  );
});

test('staging existing edits skips review', async (t) => {
  const f = await fixture(t);
  await f.write('app.js', 'already edited\n');
  await f.run(['setup', '--enable-review-gate']);
  await event(f, 'UserPromptSubmit');
  await f.git('add', '.');
  assert.deepEqual(await event(f, 'Stop'), {});
  await assert.rejects(readFile(f.env.FAKE_CLAUDE_CAPTURE), { code: 'ENOENT' });
});

test('same-size edits with preserved timestamps are reviewed', async (t) => {
  const f = await fixture(t);
  const path = join(f.repo, 'app.js');
  const original = await stat(path);
  await f.run(['setup', '--enable-review-gate']);
  await event(f, 'UserPromptSubmit');
  await f.write('app.js', 'export const value = 2;\n');
  await utimes(path, original.atime, original.mtime);
  assert.deepEqual(await event(f, 'Stop'), {});
  const request = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.match(request.input, /\+export const value = 2/);
});

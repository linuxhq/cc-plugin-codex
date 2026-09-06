import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, eventually, extractId } from './helpers.mjs';
import { parseCommand } from '../plugins/claude/scripts/lib/args.mjs';
import {
  readContextFile,
  transcriptMessages,
} from '../plugins/claude/scripts/lib/transfer.mjs';

test('task options reject conflicting modes and preserve literal input', () => {
  for (const args of [
    ['rescue', '--fresh', '--resume'],
    ['rescue', '--fresh', '--resume-last'],
    ['rescue', '--wait', '--background'],
    ['rescue', '--prompt-file', 'task.txt', 'extra'],
    ['rescue', '--resume-job', ''],
    ['transfer', '--write'],
    ['transfer', '--source', 'a', '--prompt-file', 'b'],
    ['transfer', 'unexpected'],
  ])
    assert.throws(() => parseCommand(args));

  const task = 'fix $(touch nope)\nwith `literal` arguments';
  assert.equal(parseCommand(['rescue', '--', task]).focus, task);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(parseCommand(['rescue', '--effort', effort]).effort, effort);
});

test('rescue persistence and explicit write access', async (t) => {
  const f = await fixture(t);
  const task = 'investigate $(touch nope)\nkeep `literal` text';
  const run = await f.run(['rescue', '--json', '--effort', 'high', '--', task]);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const saved = JSON.parse(run.stdout);
  let capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  const option = (name) => capture.args[capture.args.indexOf(name) + 1];
  assert.equal(capture.input, task);
  assert.equal(option('--effort'), 'high');
  assert.equal(option('--tools'), '');
  assert.equal(option('--allowedTools'), 'mcp__repository__inspect');
  assert.ok(!capture.args.includes('--no-session-persistence'));
  assert.match(saved.output, /Continue: claude --resume/);
  const candidate = JSON.parse(
    (await f.run(['rescue-resume-candidate', '--json'])).stdout,
  );
  assert.equal(candidate.jobId, saved.job.id);
  const next = await f.run([
    'rescue',
    '--resume',
    '--write',
    '--json',
    '--',
    'fix and test',
  ]);
  assert.equal(next.code, 0, next.stderr + next.stdout);
  capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.equal(option('--resume'), saved.job.claudeSessionId);
  assert.ok(!capture.args.includes('--fork-session'));
  assert.equal(option('--tools'), 'Read,Glob,Grep,Edit,Write,Bash');
  const settings = JSON.parse(option('--settings'));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(option('--permission-mode'), 'acceptEdits');
  assert.ok(!capture.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(JSON.parse(option('--mcp-config')), { mcpServers: {} });
  const nextJob = JSON.parse(next.stdout).job;
  assert.equal(nextJob.claudeSessionId, saved.job.claudeSessionId);
  const third = await f.run(['rescue', '--resume', '--json', 'inspect fix']);
  assert.equal(third.code, 0, third.stderr);
  capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.equal(option('--tools'), '');
  assert.equal(option('--resume'), nextJob.claudeSessionId);
  const other = await f.run(['rescue-resume-candidate', '--json'], {
    CODEX_THREAD_ID: 'another-session',
  });
  assert.deepEqual(JSON.parse(other.stdout), { available: false });
  assert.equal(
    (
      await f.run(['rescue', '--resume', 'continue'], {
        CODEX_THREAD_ID: 'another-session',
      })
    ).code,
    1,
  );
  assert.equal((await f.git('status', '--porcelain')).trim(), '');
});

test('empty tasks and nonpersistent reviews cannot be resumed', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['rescue'])).code, 1);
  assert.equal((await f.run(['rescue', '--resume', 'continue'])).code, 1);
  const review = JSON.parse((await f.run(['review', '--json'])).stdout);
  assert.equal(
    (await f.run(['rescue', '--resume-job', review.job.id, 'continue'])).code,
    1,
  );
});

test('background rescue saves prompt files before returning', async (t) => {
  const f = await fixture(t);
  const input = join(f.root, 'task with spaces.txt');
  await writeFile(input, 'investigate\nwithout edits');
  const launch = await f.run([
    'rescue',
    '--background',
    '--prompt-file',
    input,
  ]);
  assert.equal(launch.code, 0, launch.stderr);
  await writeFile(input, 'changed after launch');
  const id = extractId(launch.stdout);
  await eventually(async () => {
    const report = JSON.parse((await f.run(['status', id, '--json'])).stdout);
    return report.job.state === 'completed';
  });
  const capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.equal(capture.input, 'investigate\nwithout edits');
  const status = await f.run(['status', id]);
  assert.match(status.stdout, /Continue: claude --resume/);
});

function transcript() {
  return [
    { type: 'session_meta', payload: { id: 'metadata' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix the bug' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: 'Tests pass' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ text: 'private reasoning' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'tool-secret',
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
}

test('transfer saves context with tools disabled', async (t) => {
  const f = await fixture(t);
  const source = join(f.root, 'session.jsonl');
  const original = transcript();
  await writeFile(source, original);
  const run = await f.run(['transfer', '--source', source, '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.deepEqual(JSON.parse(capture.input), [
    { role: 'user', text: 'Fix the bug' },
    { role: 'assistant', text: 'Tests pass' },
  ]);
  assert.equal(capture.args[capture.args.indexOf('--tools') + 1], '');
  assert.ok(!capture.args.includes('--allowedTools'));
  assert.ok(!capture.args.includes('--no-session-persistence'));
  assert.match(JSON.parse(run.stdout).output, /claude --resume/);
  assert.equal(await readFile(source, 'utf8'), original);
  assert.equal((await f.git('status', '--porcelain')).trim(), '');
});

test('transfer discovers transcripts', async (t) => {
  const f = await fixture(t);
  const session = '12345678-1234-1234-1234-123456789abc';
  const home = join(f.root, 'codex');
  const dir = join(home, 'sessions', '2026', '09', '06');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${session}.jsonl`), transcript());
  const run = await f.run(['transfer', '--json'], {
    CODEX_HOME: home,
    CODEX_THREAD_ID: session,
  });
  assert.equal(run.code, 0, run.stderr + run.stdout);
});

test('context rejects malformed, oversized, and symlink inputs', async (t) => {
  const f = await fixture(t);
  assert.throws(() => transcriptMessages('not json'));
  assert.throws(() => transcriptMessages('{}'));
  const large = join(f.root, 'large.txt');
  await writeFile(large, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readContextFile(large), /at most 8 MiB/);
  const link = join(f.root, 'link.txt');
  await symlink(large, link);
  await assert.rejects(readContextFile(link));
});

test('missing session IDs preserve results and discard prompts', async (t) => {
  const f = await fixture(t);
  const run = await f.run(
    ['rescue', '--write', '--json', 'private-task-sentinel'],
    { FAKE_CLAUDE_MODE: 'missing-session' },
  );
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.job.state, 'completed');
  assert.match(report.output, /output is preserved/);
  assert.doesNotMatch(report.output, /Continue:/);
  const { fingerprint } = await import('../plugins/claude/scripts/lib/git.mjs');
  const saved = await readFile(
    join(
      f.env.CLAUDE_REVIEW_DATA_DIR,
      'jobs',
      fingerprint(f.repo).slice(0, 24),
      report.job.id,
      'job.json',
    ),
    'utf8',
  );
  assert.doesNotMatch(saved, /private-task-sentinel/);
  assert.equal(JSON.parse(saved).prompt, undefined);
});

test('transferred context cannot become a rescue continuation', async (t) => {
  const f = await fixture(t);
  const source = join(f.root, 'session.jsonl');
  await writeFile(source, transcript());
  const transfer = JSON.parse(
    (await f.run(['transfer', '--source', source, '--json'])).stdout,
  );
  assert.deepEqual(
    JSON.parse((await f.run(['rescue-resume-candidate', '--json'])).stdout),
    { available: false },
  );
  assert.equal(
    (
      await f.run([
        'rescue',
        '--resume-job',
        transfer.job.id,
        '--write',
        'continue',
      ])
    ).code,
    1,
  );
});

test('sensitive context filenames are refused', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, '.env');
  await writeFile(path, 'TOKEN=secret');
  await assert.rejects(readContextFile(path), /Sensitive/);
});

test('large background prompts arrive and are cleaned up', async (t) => {
  const f = await fixture(t);
  const input = join(f.root, 'large-task.txt');
  const text = 'investigate\n'.repeat(100_000);
  await writeFile(input, text);
  const launch = await f.run([
    'rescue',
    '--background',
    '--prompt-file',
    input,
  ]);
  assert.equal(launch.code, 0, launch.stderr);
  const id = extractId(launch.stdout);
  await eventually(async () => {
    const report = JSON.parse((await f.run(['status', id, '--json'])).stdout);
    return report.job.state === 'completed';
  });
  const capture = JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE));
  assert.equal(capture.input, text);
  const { fingerprint } = await import('../plugins/claude/scripts/lib/git.mjs');
  const payload = join(
    f.env.CLAUDE_REVIEW_DATA_DIR,
    'jobs',
    fingerprint(f.repo).slice(0, 24),
    id,
    'prompt.json',
  );
  await assert.rejects(readFile(payload), { code: 'ENOENT' });
});

test('upstream resume-last continues without new task text', async (t) => {
  const f = await fixture(t);
  const first = JSON.parse(
    (await f.run(['rescue', '--json', 'inspect'])).stdout,
  );
  const resumed = await f.run(['rescue', '--resume-last', '--json']);
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.equal(
    JSON.parse(resumed.stdout).job.claudeSessionId,
    first.job.claudeSessionId,
  );
});

test('removed extension flags are rejected', () => {
  for (const args of [
    ['rescue', '--resume-job', 'review-ab', 'continue'],
    ['transfer', '--prompt-file', 'summary.txt'],
    ['transfer', '--background'],
    ['transfer', '--model', 'sonnet'],
    ['transfer', '--effort', 'high'],
  ])
    assert.throws(() => parseCommand(args));
});

test('slow worker startup has no deadline', async (t) => {
  const f = await fixture(t);
  const { cp } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { runProcess } =
    await import('../plugins/claude/scripts/lib/process.mjs');
  const plugin = fileURLToPath(new URL('../plugins/claude', import.meta.url));
  const installed = join(f.root, 'slow plugin');
  await cp(plugin, installed, { recursive: true });
  const worker = join(installed, 'scripts/worker.mjs');
  await writeFile(
    worker,
    'await new Promise((resolve) => setTimeout(resolve, 11_000));\n' +
      (await readFile(worker, 'utf8')),
  );
  const launch = await runProcess(
    process.execPath,
    [
      join(installed, 'scripts/claude-review.mjs'),
      'rescue',
      '--background',
      '--json',
      'slow-start sentinel',
    ],
    { cwd: f.repo, env: f.env },
  );
  assert.equal(launch.code, 0, launch.stderr);
  const id = JSON.parse(launch.stdout).job.id;
  const done = await f.run([
    'status',
    id,
    '--wait',
    '--timeout-ms',
    '20000',
    '--poll-interval-ms',
    '100',
    '--json',
  ]);
  assert.equal(JSON.parse(done.stdout).job.state, 'completed');
  assert.equal(
    JSON.parse(await readFile(f.env.FAKE_CLAUDE_CAPTURE)).input,
    'slow-start sentinel',
  );
  assert.equal((await f.git('status', '--porcelain')).trim(), '');
});

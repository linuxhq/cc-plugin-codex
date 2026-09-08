import { writeFile, rename, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE;
const structuredReview = JSON.stringify({
  verdict: 'needs-attention',
  summary: 'This change should not ship yet.',
  findings: [
    {
      severity: 'medium',
      title: 'Example finding',
      body: 'Example failure scenario from the fake CLI.',
      file: 'app.js',
      line_start: 1,
      line_end: 1,
      confidence: 0.9,
      recommendation: 'Handle the failure.',
    },
  ],
  next_steps: [],
});
if (args[0] === '--version') {
  console.log('2.1.236 (Fake Claude Code)');
  if (mode === 'unavailable') process.exitCode = 1;
} else if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: mode !== 'unauthenticated' }));
  if (mode === 'unauthenticated') process.exitCode = 1;
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  const capture = process.env.FAKE_CLAUDE_CAPTURE;
  const temporary = `${capture}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ args, input, cwd: process.cwd(), pid: process.pid }),
  );
  await rename(temporary, capture);
  const sessionId =
    mode === 'missing-session'
      ? undefined
      : args.includes('--session-id')
        ? args[args.indexOf('--session-id') + 1]
        : args.includes('--resume')
          ? args[args.indexOf('--resume') + 1]
          : randomUUID();
  if (args.includes('stream-json')) {
    console.log(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
      }),
    );
    console.log(JSON.stringify({ type: 'tool_progress', tool_name: 'Read' }));
    if (mode === 'activity') emitActivity();
  }

  if (mode === 'inspection') await inspectDiff();

  if (process.env.FAKE_CLAUDE_HELPER_ACTIVITY) await spawnHelper();

  if (mode === 'slow') await delay(60_000);

  if (mode === 'held') await waitForRelease();

  if (mode === 'large-stderr')
    await new Promise((resolve) =>
      process.stderr.write('x'.repeat(4 * 1024 * 1024 + 1), resolve),
    );

  if (mode === 'fail' || mode === 'unauthenticated') {
    console.error(
      mode === 'fail' ? 'Provider unavailable' : 'Not authenticated',
    );
    process.exitCode = 2;
  } else if (mode === 'session-limit') {
    console.log(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result:
          "You've hit your session limit · resets 3:50pm " +
          '(America/Los_Angeles)',
      }),
    );
    process.exitCode = 1;
  } else if (mode === 'json-error') {
    console.log(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        session_id: sessionId,
        result: 'Provider request failed',
        errors: ['Account quota exhausted'],
      }),
    );
    console.error('Request could not complete');
    process.exitCode = 1;
  } else if (mode === 'malformed') {
    console.log('not json');
  } else if (mode === 'null-result') {
    console.log('null');
  } else {
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: sessionId,
        duration_ms: 123,
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
        subtype: 'success',
        is_error: false,
        ...(args.includes('--json-schema') && mode !== 'no-structured'
          ? {
              structured_output: JSON.parse(
                process.env.FAKE_CLAUDE_OUTPUT ?? structuredReview,
              ),
            }
          : {}),
        result:
          process.env.FAKE_CLAUDE_OUTPUT ??
          (input.includes('<structured_output_contract>')
            ? structuredReview
            : '## Findings\n\nP2 app.js:1 — Example finding from fake CLI.'),
      }),
    );
  }
}

function emitActivity() {
  for (const event of [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'test',
            name: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'test',
            is_error: true,
            content: 'Exit code 1\nAssertion failed',
          },
        ],
      },
    },
  ])
    console.log(JSON.stringify(event));

  for (let index = 0; index < 6; index++) {
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'PRIVATE_THINKING' },
            {
              type: 'text',
              text: `Activity ${index}: ` + 'detail '.repeat(50),
            },
          ],
        },
      }),
    );
  }
}

async function spawnHelper() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const path = process.argv[1];
    process.on('SIGTERM', () => {});
    if (process.env.FAKE_CLAUDE_HELPER_PORT) {
      const socket = require('node:net').connect(
        Number(process.env.FAKE_CLAUDE_HELPER_PORT), '127.0.0.1');
      socket.once('connect', () => process.send('ready'));
      socket.on('data', () => process.exit(0));
      socket.on('end', () => process.exit(0));
      socket.on('error', () => process.exit(0));
    }
    setInterval(() => {
      if (fs.existsSync(path + '.stop')) process.exit(0);
      fs.writeFileSync(path + '.tmp', JSON.stringify({
        pid: process.pid, time: Date.now(),
      }));
      fs.renameSync(path + '.tmp', path);
    }, 25);
  `,
      process.env.FAKE_CLAUDE_HELPER_ACTIVITY,
    ],
    {
      stdio: [
        'ignore',
        ['stdout', 'both'].includes(process.env.FAKE_CLAUDE_HELPER_STDIO)
          ? 'inherit'
          : 'ignore',
        ['stderr', 'both'].includes(process.env.FAKE_CLAUDE_HELPER_STDIO)
          ? 'inherit'
          : 'ignore',
        ...(process.env.FAKE_CLAUDE_HELPER_PORT ? ['ipc'] : []),
      ],
    },
  );
  if (process.env.FAKE_CLAUDE_HELPER_PORT) {
    await waitForHelper(child);
    if (child.connected) child.disconnect();
  }

  await writeFile(
    process.env.FAKE_CLAUDE_HELPER_ACTIVITY,
    JSON.stringify({
      pid: child.pid,
      time: Date.now(),
    }),
  );
  child.unref();
}

async function waitForHelper(child) {
  let timer;
  let onMessage;
  let onExit;
  let onError;
  let onDisconnect;
  try {
    await new Promise((resolve, reject) => {
      onMessage = (message) => {
        if (message === 'ready') resolve();
      };
      onExit = (code, signal) =>
        reject(
          new Error(`Helper exited before readiness (${signal ?? code}).`),
        );
      onError = reject;
      onDisconnect = () =>
        reject(new Error('Helper disconnected before readiness.'));
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
      child.once('disconnect', onDisconnect);
      timer = setTimeout(
        () => reject(new Error('Helper readiness timed out.')),
        5000,
      );
    });
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    throw error;
  } finally {
    clearTimeout(timer);
    child.removeListener('message', onMessage);
    child.removeListener('exit', onExit);
    child.removeListener('error', onError);
    child.removeListener('disconnect', onDisconnect);
  }
}

async function waitForRelease() {
  while (true) {
    try {
      await access(process.env.FAKE_CLAUDE_RELEASE);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await delay(50);
  }
}

async function inspectDiff() {
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  const server = config.mcpServers.repository;
  const child = spawn(server.command, server.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdin.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'inspect', arguments: { operation: 'diff' } },
    }) + '\n',
  );
  child.stdout.resume();
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

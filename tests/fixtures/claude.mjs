import { writeFile, rename, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

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
  }

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

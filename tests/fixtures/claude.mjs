import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

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
  await writeFile(
    process.env.FAKE_CLAUDE_CAPTURE,
    JSON.stringify({ args, input, cwd: process.cwd() }),
  );
  if (args.includes('stream-json')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
    console.log(JSON.stringify({ type: 'tool_progress', tool_name: 'Read' }));
  }
  if (mode === 'slow') await delay(60_000);
  if (mode === 'fail') {
    console.error('Provider unavailable');
    process.exitCode = 2;
  } else if (mode === 'json-error') {
    console.log(
      JSON.stringify({
        subtype: 'success',
        is_error: true,
        result: 'Provider request failed',
        errors: ['Account quota exhausted'],
      }),
    );
    console.error('Request could not complete');
    process.exitCode = 1;
  } else if (mode === 'malformed') {
    console.log('not json');
  } else {
    console.log(
      JSON.stringify({
        type: 'result',
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

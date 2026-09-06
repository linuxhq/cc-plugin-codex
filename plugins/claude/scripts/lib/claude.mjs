import { readFile } from 'node:fs/promises';
import { runProcess } from './process.mjs';
import {
  adversarialPrompt,
  renderAdversarial,
  schema,
  targetLabel,
} from './adversarial.mjs';
import { renderNativeReviewResult } from './render.mjs';
import { reviewStream } from './stream.mjs';

export async function buildPrompt(command, target, focus = '') {
  const instructions = await readFile(
    new URL(`../../prompts/${command}.md`, import.meta.url),
    'utf8',
  );
  if (command === 'adversarial-review')
    return adversarialPrompt(instructions, target, focus);
  const format = await readFile(
    new URL('../../prompts/findings-format.md', import.meta.url),
    'utf8',
  );
  return {
    system:
      command === 'stop-review-gate'
        ? `${instructions}\n${format}`
        : instructions,
    input: [
      `Review scope: ${target.scope}`,
      ...(target.base ? [`Base reference: ${target.base}`] : []),
      ...(command === 'stop-review-gate'
        ? []
        : [`User focus: ${JSON.stringify(focus)}`]),
      '',
      'BEGIN REVIEW DATA',
      target.context,
      'END REVIEW DATA',
      '',
    ].join('\n'),
  };
}

export function claudeArgs(job) {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    'Read,Glob,Grep',
    '--disallowedTools',
    'mcp__*',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    'user',
    '--settings',
    '{"disableAllHooks":true}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    job.prompt.system,
  ];
  if (job.command === 'adversarial-review')
    args.push('--json-schema', JSON.stringify(schema));
  if (job.target?.contextDirectory)
    args.push('--add-dir', job.target.contextDirectory);
  if (job.model) args.push('--model', job.model);
  if (job.effort) args.push('--effort', job.effort);
  return args;
}

export async function reviewWithClaude(job, signal, onProgress) {
  const stream = reviewStream(onProgress);
  const result = await runProcess('claude', claudeArgs(job), {
    cwd: job.repo,
    input: job.prompt.input,
    timeout:
      job.command === 'stop-review-gate' ? 14 * 60 * 1000 : 20 * 60 * 1000,
    signal,
    captureStdout: false,
    onStdout: stream.write,
  });
  const output = parseResult(stream.finish(), {
    ...result,
    structured: job.command === 'adversarial-review',
  });
  if (job.command === 'adversarial-review')
    return renderAdversarial(output, job.target);
  if (job.command === 'review')
    return renderNativeReviewResult(output, targetLabel(job.target));
  return output;
}

export function parseResult(stdout, options = {}) {
  const { code = 0, stderr = '', structured = false } = options;
  const result = decodeResult(stdout, stderr, code);
  if (
    code !== 0 ||
    !result ||
    result.is_error ||
    result.subtype !== 'success'
  ) {
    throw new Error(failureMessage(result, stdout, stderr, code));
  }
  if (structured) return structuredResult(result, stderr);
  if (typeof result.result !== 'string' || !result.result.trim()) {
    throw new Error(diagnostics('Claude returned an empty review.', stderr));
  }
  return result.result;
}

function structuredResult(result, stderr) {
  if (!result.structured_output)
    throw new Error(
      diagnostics('Claude returned no structured output.', stderr),
    );
  return JSON.stringify(result.structured_output);
}

function decodeResult(stdout, stderr, code) {
  try {
    return JSON.parse(stdout);
  } catch {
    if (code !== 0)
      throw new Error(
        diagnostics(stdout, stderr) || `Claude exited with code ${code}.`,
      );
    throw new Error(
      diagnostics(
        'Claude returned invalid JSON; review did not complete.',
        stdout,
        stderr,
      ),
    );
  }
}

function failureMessage(result, stdout, stderr, code) {
  const detail = diagnostics(
    result?.result,
    ...(Array.isArray(result?.errors) ? result.errors : [result?.errors]),
    result?.error,
    result?.message,
    stderr,
  );
  return (
    detail ||
    (code !== 0 ? stdout.trim() : '') ||
    (code !== 0
      ? `Claude exited with code ${code}.`
      : 'Claude did not complete the review.')
  );
}

function diagnostics(...values) {
  const messages = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) =>
      typeof value === 'string' ? value.trim() : JSON.stringify(value),
    )
    .filter(Boolean);
  return [...new Set(messages)].join('\n');
}

export async function checkSetup() {
  const version = await runProcess('claude', ['--version']);
  if (version.code !== 0)
    throw new Error(
      'Claude Code could not start. Install or repair the claude CLI.',
    );
  const auth = await runProcess('claude', ['auth', 'status', '--json']);
  if (auth.code !== 0 || JSON.parse(auth.stdout).loggedIn !== true) {
    throw new Error('Claude Code is not authenticated. Run claude auth login.');
  }
  return [
    version.stdout.trim(),
    'Authentication ready. Reviews use your local Claude account.',
    '',
  ].join('\n');
}

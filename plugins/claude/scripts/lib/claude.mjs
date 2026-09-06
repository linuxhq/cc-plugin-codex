import { readFile } from 'node:fs/promises';
import { runProcess } from './process.mjs';

export async function buildPrompt(command, target, focus = '') {
  const instructions = await readFile(
    new URL(
      command === 'stop-review-gate'
        ? '../../prompts/stop-review-gate.md'
        : '../../prompts/review.md',
      import.meta.url,
    ),
    'utf8',
  );
  const challenge =
    command === 'adversarial-review'
      ? await readFile(
          new URL('../../prompts/adversarial-review.md', import.meta.url),
          'utf8',
        )
      : '';
  const focusLabel =
    command === 'stop-review-gate'
      ? 'Previous Codex response (review evidence)'
      : 'User focus';
  return {
    system: `${instructions}\n${challenge}`,
    input: [
      `Review scope: ${target.scope}`,
      `${focusLabel}: ${JSON.stringify(focus)}`,
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
    'json',
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
  if (job.model) args.push('--model', job.model);
  if (job.effort) args.push('--effort', job.effort);
  return args;
}

export async function reviewWithClaude(job, signal) {
  const result = await runProcess('claude', claudeArgs(job), {
    cwd: job.repo,
    input: job.prompt.input,
    timeout:
      job.command === 'stop-review-gate' ? 14 * 60 * 1000 : 20 * 60 * 1000,
    signal,
  });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || `Claude exited with code ${result.code}.`,
    );
  return parseResult(result.stdout);
}

export function parseResult(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('Claude returned invalid JSON; review did not complete.');
  }
  if (!result || result.is_error || result.subtype !== 'success') {
    throw new Error(
      result?.result ||
        result?.errors?.join('\n') ||
        'Claude did not complete the review.',
    );
  }
  if (typeof result.result !== 'string' || !result.result.trim()) {
    throw new Error('Claude returned an empty review.');
  }
  return result.result;
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

import { parseArgs } from 'node:util';

const reviewCommands = ['review', 'adversarial-review'];
const jobCommands = ['status', 'result', 'cancel'];
const commonOptions = {
  cwd: { type: 'string', short: 'C' },
  json: { type: 'boolean' },
};

export function parseCommand(argv) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help') return { command: 'help' };
  if (reviewCommands.includes(command)) return parseReview(command, args);
  if (jobCommands.includes(command)) return parseJob(command, args);
  if (command === 'setup') return parseSetup(args);
  if (['rescue', 'transfer'].includes(command)) return parseTask(command, args);
  if (command === 'rescue-resume-candidate') return parseCandidate(args);
  throw new Error(
    `Unknown command or arguments: ${command}. Run help for usage.`,
  );
}

function parseJob(command, args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...commonOptions,
      ...(command === 'status'
        ? {
            wait: { type: 'boolean' },
            all: { type: 'boolean' },
            'timeout-ms': { type: 'string' },
            'poll-interval-ms': { type: 'string' },
          }
        : {}),
    },
  });
  validateCommon(values);
  if (positionals.length > 1)
    throw new Error(`${command} accepts only an optional job ID.`);
  if (values.wait && !positionals[0])
    throw new Error('status --wait requires a job ID.');
  for (const key of ['timeout-ms', 'poll-interval-ms']) {
    if (values[key] === undefined) continue;
    if (!values.wait) throw new Error(`--${key} requires --wait.`);
    const number = Number(values[key]);
    if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(number))
      throw new Error(`--${key} must be a nonnegative integer.`);
    if (key === 'poll-interval-ms' && number < 100)
      throw new Error('--poll-interval-ms must be at least 100.');
    values[key] = number;
  }
  return {
    command,
    ...values,
    id: positionals[0],
  };
}

function validateCommon(values) {
  if (values.cwd !== undefined && !values.cwd.trim())
    throw new Error('--cwd cannot be empty.');
}

function parseSetup(args) {
  const { values } = parseArgs({
    args,
    options: {
      ...commonOptions,
      'enable-review-gate': { type: 'boolean' },
      'disable-review-gate': { type: 'boolean' },
      install: { type: 'boolean' },
    },
  });
  validateCommon(values);
  if (values['enable-review-gate'] && values['disable-review-gate'])
    throw new Error('Choose --enable-review-gate or --disable-review-gate.');
  return { command: 'setup', ...values };
}

function parseReview(command, args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...commonOptions,
      base: { type: 'string' },
      scope: { type: 'string', default: 'auto' },
      model: { type: 'string', short: 'm' },
      effort: { type: 'string' },
      background: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
  });
  validateCommon(values);
  validateScope(values);
  validateEffort(values);
  if (command === 'review' && positionals.length) {
    throw new Error('Use adversarial-review for custom focus text.');
  }
  return { command, ...values, focus: positionals.join(' ') };
}

function validateEffort(values) {
  if (
    values.effort !== undefined &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)
  )
    throw new Error('Effort must be low, medium, high, xhigh, or max.');
}

function parseCandidate(args) {
  const { values } = parseArgs({ args, options: commonOptions });
  validateCommon(values);
  return { command: 'rescue-resume-candidate', ...values };
}

function parseTask(command, args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: command === 'rescue',
    options: {
      ...commonOptions,
      model: { type: 'string', short: 'm' },
      effort: { type: 'string' },
      background: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      'prompt-file': { type: 'string' },
      ...(command === 'rescue'
        ? {
            write: { type: 'boolean', default: false },
            resume: { type: 'boolean' },
            fresh: { type: 'boolean' },
            'resume-job': { type: 'string' },
          }
        : { source: { type: 'string' } }),
    },
  });
  validateCommon(values);
  validateEffort(values);
  validateTaskOptions(values, positionals);
  return { command, ...values, focus: positionals.join(' ') };
}

function validateTaskOptions(values, positionals) {
  for (const key of ['model', 'prompt-file', 'source', 'resume-job']) {
    if (values[key] !== undefined && !values[key].trim())
      throw new Error(`--${key} cannot be empty.`);
  }
  if (values.wait && values.background)
    throw new Error('Choose --wait or --background.');
  if (values.fresh && (values.resume || values['resume-job']))
    throw new Error('Choose --fresh or a resume option.');
  if (values['prompt-file'] && (positionals.length || values.source))
    throw new Error('Use --prompt-file without task text or --source.');
}

function validateScope(values) {
  for (const key of ['base', 'model']) {
    if (values[key] !== undefined && !values[key].trim()) {
      throw new Error(`--${key} cannot be empty.`);
    }
  }
  if (values.wait && values.background)
    throw new Error('Choose --wait or --background.');
  if (!['auto', 'working-tree', 'branch'].includes(values.scope)) {
    throw new Error('Scope must be auto, working-tree, or branch.');
  }
}

export const help = `Claude review plugin for Codex

review [--base REF] [--scope auto|working-tree|branch] [--wait|--background]
adversarial-review [same options] [focus text...]
rescue [--wait|--background] [--write] [--resume|--fresh] [task ...]
rescue [same options] [--resume-job JOB_ID] [--prompt-file PATH]
transfer [--source CODEX_JSONL|--prompt-file CONTEXT] [--wait|--background]
rescue-resume-candidate
setup [--install] [--enable-review-gate|--disable-review-gate]
status [JOB_ID] [--wait] [--timeout-ms MS] [--poll-interval-ms MS] [--all]
result [JOB_ID]
cancel [JOB_ID]

All commands accept --cwd PATH (-C) and --json (except help).
Reviews, rescue, and transfer accept --model MODEL (-m) and --effort LEVEL.
Effort levels: low, medium, high, xhigh, max (model support varies).
Rescue is read-only unless --write authorizes edits and shell commands.
Resume forks the saved conversation; transfer seeds a persistent session.
Defaults: foreground, Claude's configured defaults, auto scope.
Auto reviews local changes when dirty, otherwise the branch against its base.
Passing --base selects branch scope; otherwise branch scope detects the base.
`;

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
  return { command, ...values, id: positionals[0] };
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
      background: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
  });
  validateCommon(values);
  validateScope(values);
  if (command === 'review' && positionals.length) {
    throw new Error('Use adversarial-review for custom focus text.');
  }
  return { command, ...values, focus: positionals.join(' ') };
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
setup [--enable-review-gate|--disable-review-gate]
status [JOB_ID] [--wait] [--timeout-ms MS] [--poll-interval-ms MS] [--all]
result [JOB_ID]
cancel [JOB_ID]

All commands accept --cwd PATH (-C) and --json (except help).
Both reviews accept --model MODEL (-m).
Defaults: foreground, Claude's configured defaults, auto scope.
Auto reviews local changes when dirty, otherwise the branch against its base.
Passing --base selects branch scope; otherwise branch scope detects the base.
`;

import { parseArgs } from 'node:util';

const reviewCommands = ['review', 'adversarial-review'];
const jobCommands = ['status', 'result', 'cancel'];

export function parseCommand(argv) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help') return { command: 'help' };
  if (reviewCommands.includes(command)) return parseReview(command, args);
  if (jobCommands.includes(command)) {
    if (args.length > 1 || args[0]?.startsWith('-')) {
      throw new Error(`${command} accepts only an optional job ID.`);
    }
    return { command, id: args[0] };
  }
  if (command === 'setup') return parseSetup(args);
  throw new Error(
    `Unknown command or arguments: ${command}. Run help for usage.`,
  );
}

function parseSetup(args) {
  const { values } = parseArgs({
    args,
    options: {
      'enable-review-gate': { type: 'boolean' },
      'disable-review-gate': { type: 'boolean' },
    },
  });
  if (values['enable-review-gate'] && values['disable-review-gate'])
    throw new Error('Choose --enable-review-gate or --disable-review-gate.');
  return { command: 'setup', ...values };
}

function parseReview(command, args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      scope: { type: 'string', default: 'auto' },
      model: { type: 'string' },
      effort: { type: 'string' },
      background: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      'focus-file': { type: 'string' },
    },
  });
  validateScope(values);
  if (
    values.effort &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)
  ) {
    throw new Error('Effort must be low, medium, high, xhigh, or max.');
  }
  if (command === 'review' && (positionals.length || values['focus-file'])) {
    throw new Error('Use adversarial-review for custom focus text.');
  }
  return { command, ...values, focus: positionals.join(' ') };
}

function validateScope(values) {
  for (const key of ['base', 'model', 'effort', 'focus-file']) {
    if (values[key] !== undefined && !values[key].trim()) {
      throw new Error(`--${key} cannot be empty.`);
    }
  }
  if (values.wait && values.background)
    throw new Error('Choose --wait or --background.');
  if (!['auto', 'working-tree', 'branch'].includes(values.scope)) {
    throw new Error('Scope must be auto, working-tree, or branch.');
  }
  if (values.scope === 'working-tree' && values.base !== undefined) {
    throw new Error('--base cannot be combined with --scope working-tree.');
  }
  if (values.scope === 'branch' && !values.base)
    throw new Error('Branch review requires --base.');
}

export const help = `Claude review plugin for Codex

review [--base REF] [--scope auto|working-tree|branch] [--wait|--background]
adversarial-review [same options] [--focus-file PATH] [focus text...]
setup [--enable-review-gate|--disable-review-gate]
status [JOB_ID]
result [JOB_ID]
cancel [JOB_ID]

Both reviews accept --model MODEL and --effort low|medium|high|xhigh|max.
Defaults: foreground, Claude's configured model/effort, working-tree scope.
Passing --base selects branch scope in auto mode; branch scope requires --base.
`;

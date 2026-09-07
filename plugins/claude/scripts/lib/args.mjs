import { parseArgs as parseNodeArgs } from 'node:util';

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

  if (command === 'rescue') return parseTask(args);

  if (command === 'transfer') return parseTransfer(args);

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

  return {
    command,
    ...values,
    id: positionals[0],
  };
}

function resolveOption(token, options) {
  const [rawKey, inlineValue] = token.startsWith('--')
    ? token.slice(2).split('=', 2)
    : [token.startsWith('-') ? token.slice(1) : undefined];
  const key =
    Object.keys(options).find(
      (name) => options[name].short && options[name].short === rawKey,
    ) ?? rawKey;
  const option = Object.hasOwn(options, key) ? options[key] : undefined;
  return { key, inlineValue, option };
}

function normalizeArgs(args, options, allowUnknown) {
  const normalized = [];
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') {
      normalized.push(...args.slice(index));
      break;
    }

    const { key, inlineValue, option } = resolveOption(token, options);
    if (allowUnknown && !option) {
      positionals.push(token);
      continue;
    }

    if (option) {
      if (option.type === 'boolean')
        normalized.push(`--${key}=${inlineValue ?? 'true'}`);
      else if (inlineValue !== undefined)
        normalized.push(`--${key}=${inlineValue}`);
      else if (args[index + 1] !== undefined)
        normalized.push(`--${key}=${args[++index]}`);
      else normalized.push(`--${key}`);
    } else normalized.push(token);
  }

  return { normalized, positionals };
}

function parseArgs({ args, options, allowUnknown = false, ...config }) {
  const { normalized, positionals } = normalizeArgs(
    args,
    options,
    allowUnknown,
  );
  const stringOptions = Object.fromEntries(
    Object.entries(options).map(([key, option]) => [
      key,
      {
        ...option,
        type: 'string',
        ...(option.default !== undefined
          ? { default: String(option.default) }
          : {}),
      },
    ]),
  );
  const parsed = parseNodeArgs({
    ...config,
    args: normalized,
    options: stringOptions,
  });
  parsed.positionals = [...positionals, ...parsed.positionals];
  for (const key of Object.keys(parsed.values)) {
    if (options[key].type === 'boolean')
      parsed.values[key] = parsed.values[key] !== 'false';
  }

  return parsed;
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
    allowUnknown: command === 'adversarial-review',
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

function validateEffort(values) {
  if (values.effort !== undefined)
    values.effort = values.effort.trim().toLowerCase() || undefined;

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

function parseTransfer(args) {
  const { values } = parseArgs({
    args,
    options: { ...commonOptions, source: { type: 'string' } },
  });
  validateCommon(values);
  validateTaskOptions(values);
  return { command: 'transfer', ...values };
}

function parseTask(args) {
  const { values, positionals } = parseArgs({
    args,
    allowUnknown: true,
    allowPositionals: true,
    options: {
      ...commonOptions,
      model: { type: 'string', short: 'm' },
      effort: { type: 'string' },
      background: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      resume: { type: 'boolean' },
      fresh: { type: 'boolean' },
      'resume-last': { type: 'boolean' },
      'prompt-file': { type: 'string' },
    },
  });
  validateCommon(values);
  validateEffort(values);
  validateTaskOptions(values);
  return { command: 'rescue', ...values, focus: positionals.join(' ') };
}

function validateTaskOptions(values) {
  normalizeModel(values);
  for (const key of ['prompt-file', 'source']) {
    if (values[key] !== undefined && !values[key].trim())
      throw new Error(`--${key} cannot be empty.`);
  }

  if (values.wait && values.background)
    throw new Error('Choose --wait or --background.');

  if (values.fresh && (values.resume || values['resume-last']))
    throw new Error('Choose --fresh or a resume option.');
}

function validateScope(values) {
  normalizeModel(values);

  if (values.wait && values.background)
    throw new Error('Choose --wait or --background.');

  if (
    !values.base &&
    !['auto', 'working-tree', 'branch'].includes(values.scope)
  ) {
    throw new Error('Scope must be auto, working-tree, or branch.');
  }
}

function normalizeModel(values) {
  if (values.model !== undefined)
    values.model = values.model.trim() || undefined;
}

export const help = `Claude review plugin for Codex

review [--base REF] [--scope auto|working-tree|branch] [--wait|--background]
adversarial-review [same options] [focus text...]
rescue [--wait|--background] [--write] [--resume|--fresh] [task ...]
rescue [same options] [--resume-last] [--prompt-file PATH]
transfer [--source CODEX_JSONL]
rescue-resume-candidate
setup [--enable-review-gate|--disable-review-gate]
status [JOB_ID] [--wait] [--timeout-ms MS] [--poll-interval-ms MS] [--all]
result [JOB_ID]
cancel [JOB_ID]

All commands accept --cwd PATH (-C) and --json (except help).
Boolean flags accept explicit values; only =false disables a flag.
Reviews and rescue accept --model MODEL (-m). Rescue accepts --effort LEVEL.
Effort levels: low, medium, high, xhigh, max (model support varies).
Rescue is read-only unless --write authorizes edits and sandboxed commands.
Rescue reads piped stdin when no task text or --prompt-file is supplied.
Rescue and adversarial-review preserve unknown options as task/focus text.
Resume continues the saved conversation; transfer seeds a persistent session.
Defaults: foreground, Claude's configured defaults, auto scope.
Auto reviews local changes when dirty, otherwise the branch against its base.
Passing --base selects branch scope; otherwise branch scope detects the base.
`;

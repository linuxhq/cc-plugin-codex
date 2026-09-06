import { runProcess } from './process.mjs';
import { checkSetup } from './claude.mjs';
import { readGateConfig, writeGateConfig } from './gate-config.mjs';
import { workspaceRoot } from './git.mjs';
import { storeRoot } from './store.mjs';

export async function setup(options) {
  const enable = options['enable-review-gate'];
  const disable = options['disable-review-gate'];
  const repo = await workspaceRoot(process.cwd());
  const root = storeRoot(repo);
  if (enable || disable) await writeGateConfig(root, Boolean(enable));

  const [readinessResult, node, npm] = await Promise.all([
    checkReadiness(),
    binaryStatus('node'),
    binaryStatus('npm'),
  ]);
  const { readiness, missing = false } = readinessResult;
  const ready = readinessResult.ready && node.available;
  const gate = await readGateConfig(root);
  const message = setupMessage({ readiness, gate, repo, node, npm });
  return { ready, missing, workspaceRoot: repo, node, npm, gate, message };
}

function setupMessage({ readiness, gate, repo, node, npm }) {
  const message = [
    readiness.trimEnd(),
    `node: ${node.available ? node.version : 'unavailable'}`,
    `npm: ${npm.available ? npm.version : 'unavailable'}`,
    `Automatic review gate: ${gate.enabled ? 'enabled' : 'disabled'}` +
      ` for ${repo}.`,
    ...(gate?.enabled
      ? [
          'Trust the plugin hooks in /hooks; ' +
            'start a new session after installing or updating the plugin.',
        ]
      : []),
  ].join('\n');
  return message;
}

async function checkReadiness() {
  try {
    return { ready: true, readiness: await checkSetup() };
  } catch (error) {
    return {
      ready: false,
      missing: ['ENOENT', 'CLAUDE_UNAVAILABLE'].includes(error.code),
      readiness:
        error.code === 'ENOENT'
          ? 'Claude is unavailable. Install Claude Code: ' +
            'https://code.claude.com/docs/en/setup.'
          : error.message,
    };
  }
}

async function binaryStatus(command) {
  try {
    const result = await runProcess(command, ['--version']);
    return { available: result.code === 0, version: result.stdout.trim() };
  } catch {
    return { available: false };
  }
}

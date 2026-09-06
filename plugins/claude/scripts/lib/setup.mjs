import { checkSetup } from './claude.mjs';
import { readGateConfig, writeGateConfig } from './gate-config.mjs';
import { repositoryRoot } from './git.mjs';
import { storeRoot } from './store.mjs';

export async function setup(options) {
  const enable = options['enable-review-gate'];
  const disable = options['disable-review-gate'];
  let repo = null;
  try {
    repo = await repositoryRoot(process.cwd());
  } catch (error) {
    if (enable || disable) throw error;
  }

  const root = repo ? storeRoot(repo) : null;
  if (enable || disable) await writeGateConfig(root, Boolean(enable));

  const readinessResult = await checkReadiness();
  const { ready, readiness, missing = false } = readinessResult;
  const gate = root ? await readGateConfig(root) : null;
  const message = setupMessage(readiness, gate, repo);
  return { ready, missing, workspaceRoot: repo, gate, message };
}

function setupMessage(readiness, gate, repo) {
  const message = [
    readiness.trimEnd(),
    gate
      ? `Automatic review gate: ${gate.enabled ? 'enabled' : 'disabled'}` +
        ` for ${repo}.`
      : 'Review gate: run setup in a Git checkout to configure it.',
    ...(gate?.enabled
      ? [
          'Trust the Stop hook in /hooks; ' +
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
      missing: error.code === 'ENOENT',
      readiness:
        error.code === 'ENOENT'
          ? 'Claude is unavailable. Install Claude Code: ' +
            'https://code.claude.com/docs/en/setup.'
          : error.message,
    };
  }
}

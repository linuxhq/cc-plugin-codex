import { checkSetup } from './claude.mjs';
import { readGateConfig, writeGateConfig } from './gate-config.mjs';
import { repositoryRoot } from './git.mjs';
import { storeRoot } from './store.mjs';
import { installClaude } from './install.mjs';

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
  let readinessResult = await checkReadiness();
  if (options.install && readinessResult.missing)
    readinessResult = await installAndCheck();
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

async function installAndCheck() {
  try {
    const output = await installClaude();
    const checked = await checkReadiness();
    return {
      ...checked,
      readiness: [
        output,
        checked.readiness,
        checked.missing
          ? 'Add ~/.local/bin to PATH, restart your terminal, then run setup.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  } catch (error) {
    return {
      ready: false,
      missing: true,
      readiness: `Claude installation failed: ${error.message}`,
    };
  }
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
          ? 'Claude is unavailable. Run $claude:setup --install to install ' +
            'the native CLI, or see https://code.claude.com/docs/en/setup.'
          : error.message,
    };
  }
}

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
  const { ready, readiness } = await checkReadiness();
  const gate = root ? await readGateConfig(root) : null;
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
  return { ready, workspaceRoot: repo, gate, message };
}

async function checkReadiness() {
  try {
    return { ready: true, readiness: await checkSetup() };
  } catch (error) {
    return {
      ready: false,
      readiness:
        error.code === 'ENOENT'
          ? 'Claude is unavailable. Install the claude CLI and retry setup.'
          : error.message,
    };
  }
}

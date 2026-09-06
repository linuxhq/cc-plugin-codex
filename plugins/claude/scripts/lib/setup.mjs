import { checkSetup } from './claude.mjs';
import { readGateConfig, writeGateConfig } from './gate-config.mjs';
import { repositoryRoot } from './git.mjs';
import { storeRoot } from './store.mjs';

export async function setup(options) {
  const enable = options['enable-review-gate'];
  const disable = options['disable-review-gate'];
  let repo;
  try {
    repo = await repositoryRoot(process.cwd());
  } catch (error) {
    if (enable || disable) throw error;
  }
  const root = repo ? storeRoot(repo) : null;
  // Disabling must work even if Claude is missing or logged out.
  if (disable) {
    await writeGateConfig(root, false);
    return `Automatic review gate: disabled for ${repo}.`;
  }
  const ready = await checkSetup();
  if (!root)
    return `${ready}Review gate: run setup in a Git checkout to configure it.`;
  if (enable) await writeGateConfig(root, true);
  const { enabled } = await readGateConfig(root);
  return [
    ready.trimEnd(),
    `Automatic review gate: ${enabled ? 'enabled' : 'disabled'} for ${repo}.`,
    ...(enabled
      ? [
          'Trust the Stop hook in /hooks; ' +
            'start a new session after installing or updating the plugin.',
        ]
      : []),
  ].join('\n');
}

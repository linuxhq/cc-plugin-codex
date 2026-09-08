import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../plugins/claude/scripts/lib/process.mjs';
import { fixture } from './helpers.mjs';

for (const failure of ['exit', 'error', 'timeout', 'disconnect']) {
  test(`fake helper readiness reports ${failure}`, async (t) => {
    const f = await fixture(t);
    const preload = join(f.root, 'helper-failure.mjs');
    await writeFile(
      preload,
      `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const { spawn } = cp;
      cp.spawn = (command, args, options) => spawn(
        ${failure === 'error' ? "'/no/such/helper'" : 'command'},
        ['-e', ${JSON.stringify(
          failure === 'exit'
            ? 'process.exit(0)'
            : failure === 'disconnect'
              ? 'process.disconnect(); setInterval(() => {}, 100)'
              : 'setInterval(() => {}, 100)',
        )}], options);
      syncBuiltinESMExports();
    `,
    );
    const result = await runProcess(
      process.execPath,
      [
        '--import',
        preload,
        fileURLToPath(new URL('./fixtures/claude.mjs', import.meta.url)),
      ],
      {
        input: '',
        timeout: 10_000,
        env: {
          ...f.env,
          FAKE_CLAUDE_HELPER_PORT: '1',
          // A surviving helper keeps these pipes open and fails the deadline.
          FAKE_CLAUDE_HELPER_STDIO: 'both',
          FAKE_CLAUDE_HELPER_ACTIVITY: join(f.root, 'activity.json'),
        },
      },
    );
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      failure === 'error'
        ? /ENOENT/
        : failure === 'timeout'
          ? /Helper readiness timed out/
          : /Helper .* before readiness/,
    );
  });
}

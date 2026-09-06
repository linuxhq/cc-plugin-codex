import { createHash } from 'node:crypto';
import { mkdtemp, rm, chmod, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process.mjs';
import manifest from './install-manifest.json' with { type: 'json' };

// Pinned from the official release manifest; see README installer notes.
// Updating the installer requires reviewing both version and checksums here.
export async function installClaude({
  download = fetch,
  run = runProcess,
} = {}) {
  let platform = `${process.platform}-${process.arch}`;
  if (
    process.platform === 'linux' &&
    !process.report.getReport().header.glibcVersionRuntime
  )
    platform += '-musl';
  const artifact = manifest.platforms[platform];
  if (!artifact) throw new Error(`Unsupported platform: ${platform}`);
  const directory = await mkdtemp(join(tmpdir(), 'claude-install-'));
  try {
    const binary = join(directory, artifact.binary);
    const response = await download(
      'https://downloads.claude.ai/claude-code-releases/' +
        `${manifest.version}/${platform}/${artifact.binary}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(5 * 60_000),
      },
    );
    if (!response.ok || !response.body)
      throw new Error('Could not download Claude installer.');
    await verifyDownload(response.body, binary, artifact);
    await chmod(binary, 0o700);
    const installed = await run(binary, ['install', manifest.version], {
      timeout: 5 * 60_000,
    });
    if (installed.code !== 0)
      throw new Error(
        installed.stderr ||
          installed.stdout ||
          'Claude installation failed; a partial installation may remain.',
      );
    return installed.stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyDownload(body, path, artifact) {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > artifact.size)
        throw new Error('Installer exceeds pinned size.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (size !== artifact.size || hash.digest('hex') !== artifact.checksum)
      throw new Error('Installer checksum verification failed.');
  } finally {
    await file.close();
  }
}

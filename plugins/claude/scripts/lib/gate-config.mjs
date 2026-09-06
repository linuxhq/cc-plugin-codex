import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readGateConfig(root) {
  try {
    const config = JSON.parse(await readFile(join(root, 'gate.json'), 'utf8'));
    return { enabled: Boolean(config?.enabled) };
  } catch {
    return { enabled: false };
  }
}

export async function writeGateConfig(root, enabled) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'gate.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, root), 'utf8'));
const manifest = await json('plugins/claude/.codex-plugin/plugin.json');
const marketplace = await json('.agents/plugins/marketplace.json');
const pkg = await json('package.json');
assert.equal(manifest.name, 'claude');
assert.equal(marketplace.name, 'linuxhq');
const [version, cachebuster, ...extra] = manifest.version.split('+');
assert.equal(version, pkg.version);
assert.equal(extra.length, 0);
if (cachebuster !== undefined)
  assert.match(cachebuster, /^codex\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/);

assert.equal(manifest.skills, './skills/');
assert.equal(marketplace.plugins[0].name, manifest.name);
assert.equal(marketplace.plugins[0].source.path, './plugins/claude');
assert.equal(marketplace.plugins[0].policy.installation, 'AVAILABLE');
assert.equal(marketplace.plugins[0].policy.authentication, 'ON_INSTALL');

const skillRoot = new URL('plugins/claude/skills/', root);
const names = await readdir(skillRoot);
assert.deepEqual(names.sort(), [
  'adversarial-review',
  'cancel',
  'rescue',
  'result',
  'review',
  'setup',
  'status',
  'transfer',
]);
for (const name of names) {
  assert.match(name, /^[a-z-]+$/);
  const text = await readFile(new URL(`${name}/SKILL.md`, skillRoot), 'utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(header, `${name} has YAML frontmatter`);
  const metadata = parse(header[1]);
  assert.equal(metadata.name, name);
  assert.ok(metadata.description.length > 20);
  assert.ok(!text.includes('[TODO:'));
}

for (const name of ['lint', 'format', 'test']) {
  const text = await readFile(
    new URL(`.agents/skills/${name}/SKILL.md`, root),
    'utf8',
  );
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(header, `${name} has YAML frontmatter`);
  const metadata = parse(header[1]);
  assert.equal(metadata.name, name);
  assert.ok(metadata.description.length > 20);
  assert.ok(!text.includes('[TODO:'));
}

for (const path of [
  'scripts/claude-review.mjs',
  'scripts/worker.mjs',
  'prompts/review.md',
  'prompts/adversarial-review.md',
  'schemas/review-output.schema.json',
  'LICENSE',
  'NOTICE',
  'prompts/stop-review-gate.md',
  'scripts/stop-review-gate-hook.mjs',
  'hooks/hooks.json',
]) {
  await access(new URL(join('plugins/claude', path), root));
}

const hooks = await json('plugins/claude/hooks/hooks.json');
const stop = hooks.hooks.Stop[0].hooks[0];
assert.equal(stop.type, 'command');
assert.equal(
  stop.command,
  'node "${PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"',
);
assert.equal(stop.timeout, 900);
assert.ok(!Object.hasOwn(manifest, 'hooks'), 'Use default hook discovery');
console.log(
  `Validated plugin, marketplace, and ${names.length} command skills.`,
);

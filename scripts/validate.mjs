import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, root), 'utf8'));
const manifest = await json(
  'plugins/cc-plugin-codex/.codex-plugin/plugin.json',
);
const marketplace = await json('.agents/plugins/marketplace.json');
const pkg = await json('package.json');
assert.equal(manifest.name, 'cc-plugin-codex');
assert.equal(marketplace.name, 'linuxhq');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.skills, './skills/');
assert.equal(marketplace.plugins[0].name, manifest.name);
assert.equal(marketplace.plugins[0].source.path, './plugins/cc-plugin-codex');
assert.equal(marketplace.plugins[0].policy.installation, 'AVAILABLE');
assert.equal(marketplace.plugins[0].policy.authentication, 'ON_INSTALL');

const skillRoot = new URL('plugins/cc-plugin-codex/skills/', root);
const names = await readdir(skillRoot);
assert.equal(names.length, 6);
for (const name of names) {
  assert.match(name, /^claude-[a-z-]+$/);
  const text = await readFile(new URL(`${name}/SKILL.md`, skillRoot), 'utf8');
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
]) {
  await access(new URL(join('plugins/cc-plugin-codex', path), root));
}
console.log(
  `Validated plugin, marketplace, and ${names.length} command skills.`,
);

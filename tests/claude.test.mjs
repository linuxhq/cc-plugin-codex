import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claudeArgs,
  parseResult,
} from '../plugins/cc-plugin-codex/scripts/lib/claude.mjs';

test('only grants reading tools and disables hooks and MCP', () => {
  const args = claudeArgs({ prompt: { system: 'review' } });
  const option = (name) => args[args.indexOf(name) + 1];
  assert.equal(option('--tools'), 'Read,Glob,Grep');
  assert.equal(option('--allowedTools'), 'Read,Glob,Grep');
  assert.equal(option('--disallowedTools'), 'mcp__*');
  assert.equal(option('--permission-mode'), 'dontAsk');
  assert.deepEqual(JSON.parse(option('--settings')), { disableAllHooks: true });
  assert.deepEqual(JSON.parse(option('--mcp-config')), { mcpServers: {} });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--effort'));
});

for (const output of [
  'not JSON',
  '{}',
  'null',
  '{"subtype":"success","result":""}',
  '{"subtype":"error_max_turns","result":"partial text"}',
  '{"subtype":"success","is_error":true,"result":"failed"}',
]) {
  test(`does not accept an incomplete review: ${output}`, () => {
    assert.throws(() => parseResult(output));
  });
}

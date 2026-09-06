import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claudeArgs,
  parseResult,
} from '../plugins/claude/scripts/lib/claude.mjs';

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

for (const { name, stdout, stderr = '', code = 1, message } of [
  {
    name: 'session limit in a success envelope',
    stdout: JSON.stringify({
      subtype: 'success',
      is_error: true,
      result:
        "You've hit your session limit · resets 11:30pm (America/Los_Angeles)",
    }),
    message:
      "You've hit your session limit · resets 11:30pm (America/Los_Angeles)",
  },
  {
    name: 'JSON result, error list, and stderr together',
    stdout: JSON.stringify({
      subtype: 'error_during_execution',
      result: 'Review interrupted',
      errors: ['Connection reset', 'Retry exhausted'],
    }),
    stderr: 'Provider unavailable\n',
    message:
      'Review interrupted\nConnection reset\n' +
      'Retry exhausted\nProvider unavailable',
  },
  {
    name: 'structured error objects',
    stdout: JSON.stringify({
      errors: [{ message: 'Invalid model', status: 400 }],
    }),
    message: '{"message":"Invalid model","status":400}',
  },
  {
    name: 'alternative JSON error fields',
    stdout: JSON.stringify({
      error: 'authentication_error',
      message: 'Login expired',
    }),
    message: 'authentication_error\nLogin expired',
  },
  {
    name: 'plain stdout and stderr',
    stdout: 'Unable to connect\n',
    stderr: 'TLS handshake failed\n',
    message: 'Unable to connect\nTLS handshake failed',
  },
  {
    name: 'stderr alone',
    stdout: '',
    stderr: 'Unknown option\n',
    message: 'Unknown option',
  },
  {
    name: 'unrecognized JSON diagnostics',
    stdout: '{"reason":"Service unavailable"}',
    message: '{"reason":"Service unavailable"}',
  },
  {
    name: 'no output',
    stdout: '',
    code: 2,
    message: 'Claude exited with code 2.',
  },
  {
    name: 'success output with a nonzero exit still fails',
    stdout: '{"subtype":"success","result":"Partial review"}',
    message: 'Partial review',
  },
  {
    name: 'JSON errors with a zero exit still fail',
    stdout:
      '{"subtype":"success","is_error":true,"errors":["Quota exhausted"]}',
    code: 0,
    message: 'Quota exhausted',
  },
  {
    name: 'malformed output with a zero exit preserves both streams',
    stdout: 'Login required',
    stderr: 'Credentials expired',
    code: 0,
    message:
      'Claude returned invalid JSON; review did not complete.\n' +
      'Login required\nCredentials expired',
  },
  {
    name: 'empty review preserves stderr',
    stdout: '{"subtype":"success","result":""}',
    stderr: 'Request interrupted',
    code: 0,
    message: 'Claude returned an empty review.\nRequest interrupted',
  },
]) {
  test(`preserves failure diagnostics: ${name}`, () => {
    assert.throws(() => parseResult(stdout, { code, stderr }), { message });
  });
}

test('successful reviews still return the review text', () => {
  assert.equal(
    parseResult('{"subtype":"success","result":"No findings"}', {
      code: 0,
      stderr: 'Nonfatal warning',
    }),
    'No findings',
  );
});

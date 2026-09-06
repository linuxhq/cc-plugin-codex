import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt } from '../plugins/claude/scripts/lib/claude.mjs';
import * as adversarial from '../plugins/claude/scripts/lib/adversarial.mjs';

const finding = {
  severity: 'medium',
  title: 'Preserve records',
  body: 'A retry deletes the previous record.',
  file: 'app.js',
  line_start: 4,
  line_end: 6,
  confidence: 0.95,
  recommendation: 'Make the operation idempotent.',
};
const review = {
  verdict: 'needs-attention',
  summary: 'Retries can lose data.',
  findings: [finding],
  next_steps: ['Exercise the retry path.'],
};

test('context and focus survive one-pass interpolation', async () => {
  const focus = 'Check {{REVIEW_INPUT}}\n$(literal) `text`';
  const context = 'diff --git a/app.js b/app.js\n+{{USER_FOCUS}}';
  const prompt = await buildPrompt(
    'adversarial-review',
    { scope: 'branch', base: 'main', context },
    focus,
  );
  assert.ok(prompt.input.includes(`User focus: ${focus}`));
  assert.ok(prompt.input.includes(context));
  assert.ok(prompt.input.includes('Target: branch diff against main'));
  const schema = JSON.parse(prompt.system.split('\n')[1]);
  assert.ok(schema.properties.findings.items.required.includes('confidence'));
});

test('renders structured findings in upstream severity and line format', () => {
  const data = {
    ...review,
    findings: [finding, { ...finding, severity: 'high', title: 'Urgent' }],
  };
  const output = adversarial.renderAdversarial(JSON.stringify(data), {
    base: 'main',
  });
  assert.equal(
    output,
    '# Claude Adversarial Review\n\nTarget: branch diff against main\n' +
      'Verdict: needs-attention\n\nRetries can lose data.\n\nFindings:\n' +
      '- [high] Urgent (app.js:4-6)\n' +
      '  A retry deletes the previous record.\n' +
      '  Recommendation: Make the operation idempotent.\n' +
      '- [medium] Preserve records (app.js:4-6)\n' +
      '  A retry deletes the previous record.\n' +
      '  Recommendation: Make the operation idempotent.\n' +
      '\nNext steps:\n- Exercise the retry path.\n',
  );
});

test('renders an empty review without invented findings', () => {
  const data = {
    verdict: 'approve',
    summary: 'Safe to ship.',
    findings: [],
    next_steps: [],
  };
  assert.equal(
    adversarial.renderAdversarial(JSON.stringify(data), {}),
    '# Claude Adversarial Review\n\nTarget: working tree diff\n' +
      'Verdict: approve\n\nSafe to ship.\n\nNo material findings.\n',
  );
});

test('malformed output preserves upstream parse diagnostics', () => {
  const output = adversarial.renderAdversarial('not JSON', {});
  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /Parse error:/);
  assert.match(output, /Raw final message:\n\n```text\nnot JSON/);
});

for (const change of [
  { severity: 'urgent' },
  { confidence: 2 },
  { line_start: 0 },
  { line_end: 1.5 },
  { file: '' },
  { recommendation: null },
  { extra: true },
]) {
  test(`normalizes finding: ${JSON.stringify(change)}`, () => {
    const output = adversarial.renderAdversarial(
      JSON.stringify({
        ...review,
        findings: [{ ...finding, ...change }],
      }),
      {},
    );
    assert.match(output, /Retries can lose data/);
    assert.match(output, /Preserve records/);
  });
}

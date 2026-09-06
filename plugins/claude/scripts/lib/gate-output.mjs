export const gateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason'],
  properties: {
    decision: {
      type: 'string',
      enum: ['ALLOW', 'BLOCK', 'INCOMPLETE', 'SKIP'],
    },
    reason: { type: 'string', minLength: 1 },
  },
};

export function gateFailure(message) {
  return {
    systemMessage:
      `Claude automatic review could not complete:\n${message}\n\n` +
      'Run $claude:review for a manual review.\n' +
      'Run $claude:setup to check the review gate configuration.',
  };
}

export function parseGateOutput(output, { full = false } = {}) {
  let verdict;
  try {
    verdict = JSON.parse(output);
  } catch {
    return gateFailure('The reviewer returned an invalid decision.');
  }
  if (!validVerdict(verdict))
    return gateFailure('The reviewer returned an invalid decision.');
  if (!full && ['ALLOW', 'SKIP'].includes(verdict.decision)) return {};
  const reason = full ? verdict.reason.trim() : firstLine(verdict.reason);
  if (verdict.decision === 'SKIP')
    return {
      systemMessage: `Claude automatic review skipped.\n\n${reason}`,
    };
  if (verdict.decision === 'INCOMPLETE') return gateFailure(reason);
  if (verdict.decision === 'ALLOW')
    return {
      systemMessage: `Claude automatic review passed.\n\n${reason}`,
    };
  return {
    decision: 'block',
    reason:
      'Claude stop-time review found issues that still need fixes before ' +
      `ending the session.\n\n${reason}`,
  };
}

// Keep stored verdicts machine-readable for the hook; render at the result UI.
export function renderGateResult(output) {
  const verdict = parseGateOutput(output, { full: true });
  return (
    '# Claude Automatic Review\n\n' + (verdict.reason || verdict.systemMessage)
  );
}

function firstLine(reason) {
  return reason.trim().split(/\r?\n/, 1)[0].trim();
}

function validVerdict(verdict) {
  return (
    verdict &&
    ['ALLOW', 'BLOCK', 'INCOMPLETE', 'SKIP'].includes(verdict.decision) &&
    typeof verdict.reason === 'string' &&
    verdict.reason.trim() &&
    Object.keys(verdict).every((key) => ['decision', 'reason'].includes(key))
  );
}

export const gateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['ALLOW', 'BLOCK', 'INCOMPLETE'] },
    reason: { type: 'string', minLength: 1 },
  },
};

export function gateFailure(message) {
  return {
    systemMessage:
      `Claude automatic review could not complete:\n${message}\n` +
      'Run $claude:review for a manual review.\n' +
      'Run $claude:setup to check the review gate configuration.',
  };
}

export function parseGateOutput(output) {
  let verdict;
  try {
    verdict = JSON.parse(output);
  } catch {
    return gateFailure('The reviewer returned an invalid decision.');
  }
  if (
    !verdict ||
    !['ALLOW', 'BLOCK', 'INCOMPLETE'].includes(verdict.decision) ||
    typeof verdict.reason !== 'string' ||
    !verdict.reason.trim() ||
    Object.keys(verdict).some((key) => !['decision', 'reason'].includes(key))
  )
    return gateFailure('The reviewer returned an invalid decision.');
  if (verdict.decision === 'INCOMPLETE') return gateFailure(verdict.reason);
  if (verdict.decision === 'ALLOW')
    return {
      systemMessage: `Claude automatic review passed: ${verdict.reason}`,
    };
  return {
    decision: 'block',
    reason:
      'Claude stop-time review found issues that still need fixes before ' +
      `ending the session: ${verdict.reason}`,
  };
}

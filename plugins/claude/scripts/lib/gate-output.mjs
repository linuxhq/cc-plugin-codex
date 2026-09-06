export function gateFailure(message) {
  return {
    decision: 'block',
    reason:
      `Claude automatic review could not complete:\n${message}\n\n` +
      'Run $claude:review --wait manually or bypass the gate.',
  };
}

export function parseGateOutput(output) {
  const first = String(output ?? '')
    .trim()
    .split(/\r?\n/, 1)[0];

  if (first.startsWith('ALLOW:')) return {};

  if (first.startsWith('BLOCK:')) {
    return {
      decision: 'block',
      reason:
        'Claude stop-time review found issues that still need fixes ' +
        'before ending the session: ' +
        (first.slice('BLOCK:'.length).trim() || output.trim()),
    };
  }

  return gateFailure('The reviewer returned an unexpected answer.');
}

export function renderGateResult(output) {
  return output;
}

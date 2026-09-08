export function gateFailure(message) {
  return {
    decision: 'block',
    reason:
      `Claude automatic review could not complete:\n${message}\n\n` +
      'Run $claude:review --wait manually or bypass the gate.',
  };
}

export function parseGateOutput(output) {
  const lines = String(output ?? '')
    .trim()
    .split(/\r?\n/);
  const verdicts = lines.filter((line) => /^\s*(ALLOW|BLOCK):/.test(line));
  const verdict = verdicts[0];
  if (
    verdicts.length !== 1 ||
    (verdict !== lines[0] &&
      (verdict !== lines.at(-1) ||
        !/^(ALLOW|BLOCK):\s*\S/.test(verdict) ||
        lines.some((line) => /^\s*(`{3,}|~{3,})/.test(line))))
  )
    return gateFailure('The reviewer returned an unexpected answer.');

  if (verdict.startsWith('ALLOW:')) return {};

  if (verdict.startsWith('BLOCK:')) {
    return {
      decision: 'block',
      reason:
        'Claude stop-time review found issues that still need fixes ' +
        'before ending the session: ' +
        (verdict.slice('BLOCK:'.length).trim() || output.trim()),
    };
  }

  return gateFailure('The reviewer returned an unexpected answer.');
}

export function renderGateResult(output) {
  return output;
}

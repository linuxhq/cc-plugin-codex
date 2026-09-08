export function gateFailure(message) {
  return {
    decision: 'block',
    reason:
      `Claude automatic review could not complete:\n${message}\n\n` +
      'Run $claude:review --wait manually or bypass the gate.',
  };
}

export function parseGateOutput(output) {
  const text = String(output ?? '').trim();
  const lines = text.split(/\r?\n/);
  const verdicts = [...text.matchAll(/\b(ALLOW|BLOCK)\b/g)];
  const blocking = verdicts.find((match) => match[1] === 'BLOCK');
  if (blocking) {
    const canonical = [lines[0], lines.at(-1)].find((line) =>
      /^BLOCK:\s*\S/.test(line),
    );
    const reason = canonical
      ? canonical.slice('BLOCK:'.length).trim()
      : text
          .slice(blocking.index + blocking[0].length)
          .split(/\r?\n/, 1)[0]
          .replace(/^[\s:*_`]+/, '')
          .trim();
    return {
      decision: 'block',
      reason:
        'Claude stop-time review found issues that still need fixes ' +
        'before ending the session: ' +
        (reason || text),
    };
  }

  if (verdicts.length !== 1)
    return gateFailure('The reviewer returned an unexpected answer.');

  if (lines[0].startsWith('ALLOW:')) return {};

  if (
    /^ALLOW:\s*\S/.test(lines.at(-1)) &&
    !lines.some((line) => /^\s*(`{3,}|~{3,})/.test(line))
  )
    return {};

  return gateFailure('The reviewer returned an unexpected answer.');
}

export function renderGateResult(output) {
  return output;
}

// Adapted from OpenAI's Codex plugin. See ../../NOTICE and ../../LICENSE.
const severities = ['critical', 'high', 'medium', 'low'];

export function renderNativeReviewResult(output, target) {
  return `# Claude Review\n\nTarget: ${target}\n\n${output.trim()}\n`;
}

export function renderReviewResult(data, target) {
  const findings = [...data.findings].sort(
    (left, right) =>
      severities.indexOf(left.severity) - severities.indexOf(right.severity),
  );
  const lines = [
    '# Claude Adversarial Review',
    '',
    `Target: ${target}`,
    `Verdict: ${data.verdict.trim()}`,
    '',
    data.summary.trim(),
    '',
  ];
  if (findings.length === 0) {
    lines.push('No material findings.');
  } else {
    lines.push('Findings:');
    for (const finding of findings) {
      const end =
        finding.line_end > finding.line_start ? `-${finding.line_end}` : '';
      const location = `${finding.file.trim()}:${finding.line_start}${end}`;
      lines.push(
        `- [${finding.severity}] ${finding.title.trim()} (${location})`,
        `  ${finding.body.trim()}`,
      );
      if (finding.recommendation.trim())
        lines.push(`  Recommendation: ${finding.recommendation.trim()}`);
    }
  }

  const steps = data.next_steps.map((step) => step.trim()).filter(Boolean);
  if (steps.length) {
    lines.push('', 'Next steps:');
    for (const step of steps) lines.push(`- ${step}`);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

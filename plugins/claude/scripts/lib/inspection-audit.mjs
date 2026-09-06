import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Private runtime state, outside the repository tool scope.
export async function withInspectionAudit(job, review) {
  if (job.command !== 'stop-review-gate') return review(job);
  const directory = await mkdtemp(join(tmpdir(), 'claude-inspection-'));
  const audit = join(directory, 'audit.json');
  try {
    await writeFile(audit, JSON.stringify({ successes: 0, failures: 0 }), {
      mode: 0o600,
    });
    const output = await review({ ...job, inspectionAudit: audit });
    // Require evidence for every passing verdict; preserve blocking findings
    // and explicit explanations of incomplete reviews.
    if (!['ALLOW', 'SKIP'].includes(JSON.parse(output)?.decision))
      return output;
    const evidence = JSON.parse(await readFile(audit, 'utf8'));
    if (evidence.successes > 0) return output;
    return JSON.stringify({
      decision: 'INCOMPLETE',
      reason: 'No successful repository inspection was recorded.',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

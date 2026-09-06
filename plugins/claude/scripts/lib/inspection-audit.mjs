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
    // Audit approval only; missing evidence must never erase blocking findings
    // or the reviewer's explanation of why inspection was skipped/incomplete.
    if (JSON.parse(output)?.decision !== 'ALLOW') return output;
    const evidence = JSON.parse(await readFile(audit, 'utf8'));
    if (evidence.successes > 0 && evidence.failures === 0) return output;
    return JSON.stringify({
      decision: 'INCOMPLETE',
      reason:
        evidence.failures > 0
          ? 'Repository inspection failed or returned truncated evidence.'
          : 'No successful repository inspection was recorded.',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

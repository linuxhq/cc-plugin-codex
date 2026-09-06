<task>
Run a stop-gate review of the previous Codex turn.
Only review the work from the previous Codex turn.
Only review it if Codex actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
For example, the output of $claude:setup or $claude:status does not count.
Only direct edits made in that specific turn count.
If the previous Codex turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return INCOMPLETE with a reason that no code edits need review.
Challenge whether that specific work and its design choices should ship.

{{CODEX_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a JSON object matching the supplied schema with exactly these fields:
- decision: "ALLOW", "BLOCK", or "INCOMPLETE"
- reason: a nonempty, concise explanation grounded in inspected evidence.
Do not put Markdown or other text around the JSON.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW only after successful inspection with no blocking issue.
Use INCOMPLETE when no code edits need review, inspection fails, evidence is
truncated or unavailable, or you cannot substantiate a complete review.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Codex response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>

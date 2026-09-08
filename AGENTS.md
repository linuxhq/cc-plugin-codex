# Contributing

This project adapts
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) to run
Claude from Codex.

- The plugin lives in `plugins/claude/`.
- User-facing workflows and limitations belong in [README.md](README.md).

## Upstream parity

### Baseline and behavior

- Match upstream features, defaults, workflows, limits, and cleanup policies.
- Change behavior only when the host/provider requires it or the user asks.
  Explain each difference.
- Before changing behavior, read the matching upstream command, agent, prompt,
  and runtime at the revision in [NOTICE](plugins/claude/NOTICE).
- Check upstream HEAD when updating the baseline. Leave the upstream checkout
  unchanged.

### Scope of changes

- Prefer small adaptations. Simplify or remove buggy extra behavior before
  adding machinery.
- Verify findings against upstream and the user's request. Do not turn review
  suggestions into unrequested features.
- No legacy support: remove compatibility code and do not add migrations or
  fallbacks for older versions or formats.
- Keep current race and lifecycle protection.
- Keep README, skills, help, prompts, and tests consistent.
- Document unavoidable limitations and correct unsupported promises instead of
  building extra behavior to fulfill them.
- Reviews only review. Rescue performs the user's authorized task.

## Adaptation constraints

### Host and tools

- Codex skills and hooks replace Claude Code commands and hooks.
- Rescue forwards directly to the runtime because the upstream named subagent
  type is unavailable here.
- GPT-specific guidance and the `spark` alias do not apply.
- Claude's CLI replaces the app-server API. Normal review uses a correctness
  prompt.
- Read-only runs use the inspection MCP tool.
- Write rescue uses Claude's native tools and sandbox. Do not add a custom
  writer or filter authorized configuration/build-script edits.

### Review scope

- Branch reviews read surrounding code at `HEAD`.
- Preserve upstream Git text conversion, symlink target reads, and binary
  sampling.
- Auto scope uses parent repository file lists, so untracked submodule contents
  alone do not make it dirty.
- Preserve the deliberate origin-HEAD correction: use the remote ref even
  without a matching local branch.

### Review gate and hook deadlines

- Gate review has no snapshot cache or continued-turn exemption.
- Keep the first-line verdict contract and documented Claude adaptation
  accepting a single final-line verdict with a reason after prose.
- Ambiguous or missing verdicts block.
- Count uppercase whole words `ALLOW` and `BLOCK` everywhere; no colon required.
- Any `BLOCK` blocks. Prefer a canonical first- or final-line blocking reason,
  then the first detected block. A pass requires exactly one `ALLOW`.
- Prose and quotes have no exemption. False blocks are an accepted tradeoff.
- Unreadable gate settings default to disabled.
- Invalid hook input reports a hook error.
- Allow one minute for cleanup within the 15-minute Stop deadline.
- SessionEnd uses Codex's 3-second limit.

### Background jobs and process lifetime

- Background launch saves a private prompt before returning. The worker removes
  it after reading.
- Do not add a prompt acknowledgment deadline.
- Supervisors own Claude and inspection descendants through cancellation and
  worker death. Preserve force-kill escalation, including when Claude exits
  first.
- Complete jobs after Claude exits and output is forwarded. Drain later helper
  output.
- Retain helpers until they exit or SessionEnd. Without a host session, stop
  them when the run ends.

### Failure reporting and cancellation

- Supervisor failure diagnostics are a Claude CLI adaptation.
- Allow at most one second for delivery before force-kill. Retain parent-side
  escalation after an error report.
- Report signal termination if no diagnostic arrives.
- Keep ordinary cancellation separate from failure reporting.
- Repeated SIGTERM preserves the supervisor's two-second cancellation grace.
- SIGTERM during failure reporting may force-kill immediately.

### History and cleanup

- Retain the 50 most recently updated jobs in any state.
- Phase/session changes refresh retention. Heartbeats do not.
- Pruning removes history and logs without stopping execution.
- Keep session ownership and control files for workers and surviving helpers,
  including after history eviction.
- Reclaim abandoned files only when their owner is known to have exited. Stale
  heartbeats alone are insufficient.
- Cleanup must tolerate concurrent removal and continue past individual
  failures.

### Final logging

- Save terminal results before appending the final log.
- Deliberately tolerate `ENOENT` from that final append so concurrent cleanup
  cannot fail a completed run.
- Other logging errors propagate as upstream does.
- No proof of cleanup is required. Checking that the directory is gone cannot
  establish why it was removed.
- Narrow this exception only for a demonstrated failure or a requested policy
  change.

## Checks

Install development dependencies with `npm ci`. Follow the local
[lint](.agents/skills/lint/SKILL.md), [format](.agents/skills/format/SKILL.md),
and [test](.agents/skills/test/SKILL.md) skills for every change:

```sh
npm run lint -- --fix
npm run format
npm run check
```

- Fix failures; do not disable checks. `check` covers lint, formatting,
  plugin/skill validation, and the full test suite.
- Use `padding-line-between-statements` after control-flow blocks; keep `else`,
  `catch`, and `finally` attached. Let Prettier handle other formatting.
- Tests must use the fake Claude CLI and consume no Claude usage.

## Releases

Follow the [release](.agents/skills/release/SKILL.md) skill for version bumps
and releases.

- Publish only after all GitHub CI for the exact release commit passes.
- This includes branch workflows, tag workflows, and every matrix job.

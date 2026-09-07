# Contributing

This project adapts
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) to run
Claude from Codex. The plugin lives in `plugins/claude/`; user-facing workflows
and limitations belong in [README.md](README.md).

## Upstream parity

- Match upstream features, defaults, workflows, limits, and cleanup policies.
  Change behavior only when the host/provider requires it or the user asks;
  explain each difference.
- Before changing behavior, read the matching upstream command, agent, prompt,
  and runtime at the revision in [NOTICE](plugins/claude/NOTICE). Check upstream
  HEAD when updating the baseline. Leave the upstream checkout unchanged.
- Prefer small adaptations. Simplify or remove buggy extra behavior before
  adding machinery. Verify findings against upstream and the user's request; do
  not turn review suggestions into unrequested features.
- No legacy support: remove compatibility code and do not add migrations or
  fallbacks for older versions or formats. Keep current race and lifecycle
  protection.
- Keep README, skills, help, prompts, and tests consistent. Document unavoidable
  limitations and correct unsupported promises instead of building extra
  behavior to fulfill them.
- Reviews only review. Rescue performs the user's authorized task.

## Adaptation constraints

- Codex skills and hooks replace Claude Code commands and hooks. Rescue forwards
  directly to the runtime because the upstream named subagent type is
  unavailable here. GPT-specific guidance and the `spark` alias do not apply.
- Claude's CLI replaces the app-server API; normal review uses a correctness
  prompt. Read-only runs use the inspection MCP tool; write rescue uses Claude's
  native tools and sandbox. Do not add a custom writer or filter authorized
  configuration/build-script edits.
- Branch reviews read surrounding code at `HEAD`. Preserve upstream Git text
  conversion, symlink target reads, and binary sampling. Auto scope uses parent
  repository file lists, so untracked submodule contents alone do not make it
  dirty. Preserve the deliberate origin-HEAD correction: use the remote ref even
  without a matching local branch.
- Gate review has no snapshot cache or continued-turn exemption. Keep the
  first-line verdict contract and documented Claude adaptation accepting a
  single final-line verdict with a reason after prose. Ambiguous or missing
  verdicts block; unreadable gate settings default to disabled. Invalid hook
  input reports a hook error. Allow one minute for cleanup within the 15-minute
  Stop deadline; SessionEnd uses Codex's 3-second limit.
- Background launch saves a private prompt before returning; the worker removes
  it after reading. Do not add a prompt acknowledgment deadline.
- Supervisors own Claude and inspection descendants through cancellation and
  worker death. Preserve force-kill escalation, including when Claude exits
  first. Complete jobs after Claude exits and output is forwarded; drain later
  helper output. Retain helpers until they exit or SessionEnd; without a host
  session, stop them when the run ends.
- Retain the 50 most recently updated jobs in any state. Phase/session changes
  refresh retention; heartbeats do not. Pruning removes history and logs without
  stopping execution. Keep session ownership and control files for workers and
  surviving helpers, including after history eviction. Reclaim abandoned files
  only when their owner is known to have exited; stale heartbeats alone are
  insufficient. Cleanup must tolerate concurrent removal and continue past
  individual failures.

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
and releases. Publish only after all GitHub CI for the exact release commit
passes, including branch workflows, tag workflows, and every matrix job.

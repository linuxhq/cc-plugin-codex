---
name: setup
description:
  Check Claude Code readiness and enable or disable automatic reviews before
  Codex finishes a turn in the current Git checkout.
---

Resolve the plugin root two directories above this skill directory. Run from the
user's checkout, using the actual quoted plugin path:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" setup
```

When the user requests a gate change, append `--enable-review-gate` or
`--disable-review-gate` as requested. Never pass both. With no flag, setup
checks readiness and reports the current gate setting without changing it.
Enabling checks authentication first; disabling works even if Claude is
unavailable. The setting persists per Git checkout outside the repository.

Report the result. Setup does not start a paid review. If the executable is
missing, point to `https://code.claude.com/docs/en/setup`. If authentication is
missing, tell the user to run `claude auth login` in their terminal.

The bundled Stop hook requires Codex hook support and user trust. When enabling,
explain that the user must review and trust it in Codex's `/hooks` interface,
and start a new session after installing or updating the plugin. Do not bypass
hook trust or change Codex configuration. Enabling the plugin's gate setting
alone does not establish that Codex loaded and trusted the hook.

Once enabled and trusted, the hook asks Claude to review the previous turn.
BLOCK sends Codex back to assess the findings, automatically fix the issues it
agrees with within the authorized scope, and run relevant checks. It explains
rejected findings with evidence instead of blindly applying them, and reports
fixes and validation before finishing. The hook skips a Stop-triggered
continuation to prevent endless review loops; use `$claude:review` to verify
fixes. Automatic reviews consume the local Claude account's usage and are
visible through `$claude:status`, `$claude:result`, and `$claude:cancel`. A
successful setup confirms local credentials exist; actual reviews can still fail
due to provider, network, quota, or model availability errors.

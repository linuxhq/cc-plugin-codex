---
name: setup
description: >-
  Check Claude setup and toggle reviews. Args: --enable-review-gate,
  --disable-review-gate.
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

The bundled UserPromptSubmit and Stop hooks require Codex hook support and user
trust. When enabling, explain that the user must review and trust both in
Codex's `/hooks` interface, and start a new session after installing or updating
the plugin. Do not bypass hook trust or change Codex configuration. Enabling the
plugin's gate setting alone does not establish that Codex loaded and trusted the
hook.

Once enabled and trusted, UserPromptSubmit saves a starting snapshot and Stop
sends only the turn's Git diff to Claude. Unchanged turns skip Claude even with
older uncommitted edits. Missing snapshots skip with an explanatory message.
BLOCK sends Codex back with a short message saying issues still need fixes, the
reviewer's first-line summary, and the review job ID. Full findings remain
available through `$claude:result`. The hook skips a Stop-triggered continuation
to prevent endless review loops; use `$claude:review` to verify fixes. Automatic
reviews consume the local Claude account's usage and are visible through
`$claude:status`, `$claude:result`, and `$claude:cancel`. A successful setup
confirms local credentials exist; actual reviews can still fail due to provider,
network, quota, or model availability errors.

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
checks readiness and reports the current gate setting without changing it. Gate
changes are saved before checking readiness, even if Claude is unavailable or
unauthenticated. Report both the saved setting and readiness guidance. The
setting persists per Git checkout outside the repository.

Report the result. Setup does not start a paid review. If the executable is
missing, point to `https://code.claude.com/docs/en/setup`. If authentication is
missing, tell the user to run `claude auth login` in their terminal.

The bundled Stop hook requires Codex hook support and user trust. When enabling,
explain that the user must trust it in `/hooks` and start a new session after
installing or updating the plugin.

The gate sends the previous Codex response to Claude to review that turn's work.
Claude returns ALLOW for turns without code edits or blocking findings, and
BLOCK for issues that need fixing. Subsequent Stop events run the gate again.
Reviews consume Claude usage and appear in status, result, and cancel commands.

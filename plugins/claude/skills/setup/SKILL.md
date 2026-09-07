---
name: setup
description: >-
  Check Claude setup and toggle reviews. Args: --enable-review-gate,
  --disable-review-gate.
---

Resolve the plugin root two directories above this skill directory. Run from the
user's checkout, using the actual quoted plugin path:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" setup --json
```

When the user requests a gate change, append `--enable-review-gate` or
`--disable-review-gate` as requested. Never pass both. With no flag, setup
checks readiness and reports the current gate setting without changing it. Gate
changes are saved before checking readiness, even if Claude is unavailable or
unauthenticated. Report both the saved setting and readiness guidance. The
setting persists per Git checkout, or per current directory outside Git, in the
plugin's external data store.

If the report says `missing: true` and `npm.available: true`, ask once whether
to install Claude, offering `Install Claude (Recommended)` and `Skip for now`.
If installation is already authorized, proceed without asking again. For an
approved installation, run:

```sh
npm install -g @anthropic-ai/claude-code
```

Then rerun setup with the original flags and present the final report. If the
user skips installation, present the original report. Do not offer installation
when Claude is available or npm is unavailable. In the latter case, preserve the
official installation guidance at `https://code.claude.com/docs/en/setup`. If
authentication is missing, tell the user to run `claude auth login` in their
terminal. Setup does not start a paid review.

The bundled Stop and SessionEnd hooks require Codex hook support and user trust.
Explain that the user must trust the plugin hooks in `/hooks` and start a new
session after installing or updating the plugin. SessionEnd requests
cancellation for this session's unfinished jobs; workers remove their records
after stopping. Finished records are removed immediately. A worker that never
recovers can leave records behind. The gate setting is preserved.

The gate sends the previous Codex response to Claude to review that turn's work.
Claude returns `ALLOW: <reason>` when there are no blocking findings (including
turns with no edits), or `BLOCK: <reason>` when fixes are needed. Failed reviews
and unexpected output block with guidance to run a manual review or bypass the
gate; unavailable Claude produces setup guidance. Session-limit failures also
block and preserve the provider's reset guidance. Reviews consume Claude usage
and appear in status, result, and cancel commands.

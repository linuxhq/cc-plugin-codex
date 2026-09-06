---
name: transfer
description:
  Hand off the current Codex conversation to a persistent Claude session for
  continuation in Claude Code.
---

Resolve the plugin root two directories above this skill directory and run from
the user's checkout:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" transfer
```

The runtime locates the current Codex session transcript using CODEX_THREAD_ID
or CODEX_SESSION_ID under CODEX_HOME (default ~/.codex). The user may select a
specific Codex JSONL transcript with `--source PATH` instead. The source must
resolve under `CODEX_HOME/sessions` or `CODEX_HOME/archived_sessions`; symlinks
to transcripts there are accepted.

If the transcript is unavailable, report the runtime error and the `--source`
guidance. Return the result and `claude --resume SESSION_ID` command verbatim.

Claude does not expose Codex's native external-session importer. This adapter
seeds user/assistant text into one persistent Claude turn with tools disabled.
It makes a paid call to acknowledge the context, without carrying out embedded
tasks. Tool outputs, reasoning, system instructions, images, and attachments are
not transferred. Claude's context limits apply. Source files are unchanged.

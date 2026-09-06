---
name: transfer
description:
  Hand off the current Codex conversation to a persistent Claude session for
  continuation in Claude Code.
---

Resolve the plugin root two directories above this skill directory and run from
the user's checkout:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" transfer --wait
```

The runtime locates the current Codex session transcript using CODEX_THREAD_ID
or CODEX_SESSION_ID under CODEX_HOME (default ~/.codex). The user may select a
specific Codex JSONL transcript with `--source PATH` instead.

If the transcript is unavailable, create a private temporary UTF-8 context file
with the user's objective, constraints, decisions, completed changes, test
results, and next steps, then pass `--prompt-file PATH`. Be clear that this is a
summary handoff. Remove the temporary file after the CLI returns. Never copy
credentials or unrelated session history into the handoff.

Honor `--model`, `--effort`, and `--background` if supplied. Default to waiting.
This starts a paid Claude call with tools disabled to acknowledge and save the
context. It does not carry out tasks embedded in the conversation. Return the
result and `claude --resume SESSION_ID` command. Background mode returns a job
ID; use status/result later for the continuation command.

This is a context handoff, not native transcript import: user/assistant text is
seeded into one Claude turn. Tool outputs, reasoning, system instructions,
images, and attachments are not transferred. Inputs over 8 MiB are rejected; use
a focused context file instead. Source files and the repository are unchanged.

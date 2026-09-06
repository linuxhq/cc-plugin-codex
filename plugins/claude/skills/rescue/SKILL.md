---
name: rescue
description:
  Delegate investigation, an authorized fix, or follow-up work to Claude from
  Codex.
---

Resolve the plugin root two directories above this skill directory. Run the
bundled CLI from the user's checkout with the actual quoted plugin path:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" rescue --wait -- "task"
```

Forward the user's task and constraints faithfully. Pass arguments separately,
with `--` before task text, or write multiline task text to a private temporary
file and pass `--prompt-file PATH`. Remove temporary input after the CLI
returns; background launch saves its own copy before returning.

Respect `--wait` and `--background`; default to foreground when neither is
given. Background launch returns a job ID: report it without polling. Foreground
runs should be polled through completion. Return Claude's result verbatim,
including continuation commands and failures.

Add `--write` for an implementation task unless the user asks for read-only work
or only wants review, diagnosis, or research. Write mode uses Claude's built-in
file tools and sandboxed Bash for edits and validation. Hooks are disabled.
Carry the authorized scope into the task text.

Preserve explicit `--model` and `--effort` values; otherwise leave them unset.
Effort levels are low, medium, high, xhigh, and max, subject to model support.

For continuation:

- Honor `--resume`, `--resume-last`, or `--fresh` without asking again.
- Otherwise run `rescue-resume-candidate --json` using the same CLI.
- If a candidate exists, use the available question tool once to ask whether to
  continue the current Claude thread or start a new one. Recommend continuing
  for an obvious follow-up, otherwise recommend a new thread. Append `--resume`
  or `--fresh` to reflect the answer.
- Candidates belong to this checkout and Codex session. Resume continues the
  saved Claude conversation. Choose write access from the current task.

If no task was supplied, ask what Claude should investigate or fix. If Claude is
missing or unauthenticated, report the runtime guidance and use `$claude:setup`.

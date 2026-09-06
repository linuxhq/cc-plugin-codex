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

Investigations default to read-only repository inspection. Add `--write` when
the user's task authorizes edits or running shell commands/tests. This grants
Claude file and shell tools in the checkout; it does not authorize publishing,
deploying, or unrelated actions. Carry those scope limits into the task text. Do
not enable write access merely to get a more thorough read-only review.

Preserve explicit `--model` and `--effort` values; otherwise leave them unset.
Effort levels are low, medium, high, xhigh, and max, subject to model support.

For continuation:

- Honor `--resume`, `--resume-job JOB_ID`, or `--fresh` without asking again.
- Otherwise run `rescue-resume-candidate --json` using the same CLI.
- For an obvious follow-up, use `--resume` if a candidate exists. For a new
  task, use `--fresh`. Ask only when it is unclear whether the user wants
  continuation.
- A candidate belongs to this checkout and Codex session. `--resume-job` selects
  a particular finished job in the checkout, including one from an older
  session.
- Each resumed run forks the saved Claude conversation. It preserves prior
  context without concurrently modifying the source session. Write access must
  be authorized again by the current task; it is never inherited automatically.

If no task was supplied, ask what Claude should investigate or fix. If Claude is
missing or unauthenticated, report the runtime guidance and use `$claude:setup`.

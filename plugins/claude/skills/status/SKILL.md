---
name: status
description:
  Show active and recent Claude jobs for this repository, including review-gate
  status
---

Run from the user's repository, resolving the plugin root two directories above
this skill directory:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" status
```

Pass the user's arguments individually. Supported arguments:
`[JOB_ID] [--wait] [--timeout-ms MS] [--poll-interval-ms MS] [--all] [--cwd PATH] [--json]`.

If the user did not pass a job ID:

- Return the command's single Markdown table for current and past runs in this
  session. Without a Codex session ID, the CLI shows repository history.
- Keep it compact. Do not include progress blocks or extra prose outside the
  table.
- Preserve job ID, kind, status, phase, elapsed or duration, summary, and
  follow-up commands. `--all` includes all history in the selected session.

If the user did pass a job ID:

- Present the full command output to the user.
- Do not summarize or condense it.
- `--wait` waits until that job is no longer active or the timeout expires.
- Poll the host process until the status command itself finishes. Default
  timeout: 240000 ms. Default polling interval: 2000 ms.
- A timeout leaves the review running. Preserve the timeout message and current
  state; do not report it as completed.

With `--json`, return the JSON output verbatim instead of a Markdown table.
`interrupted` means the worker's heartbeat is stale, not that Claude completed
successfully. Use `$claude:result JOB_ID` to retrieve findings.

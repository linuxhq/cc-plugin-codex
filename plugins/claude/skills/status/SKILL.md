---
name: status
description: Show active and recent Claude jobs
argument-hint: '[job-id]'
---

Resolve the plugin root two directories above this skill directory. Run from the
user's repository with the actual quoted path:

```sh
node /absolute/plugin/root/scripts/claude-review.mjs status
```

Pass the user's optional job ID as a separate argument. Without it, the command
shows the ten latest jobs in this checkout, across Codex sessions. Display the
reported states. `interrupted` means the worker's heartbeat is stale, not that
Claude completed successfully. Use `$claude:result JOB_ID` to retrieve findings.

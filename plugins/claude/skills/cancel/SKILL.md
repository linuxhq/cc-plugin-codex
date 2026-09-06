---
name: cancel
description: >-
  Cancel an active Claude job. Args: [job-id].
---

Resolve the plugin root two directories above this skill directory. Run from the
user's repository with the actual quoted path:

```sh
node /absolute/plugin/root/scripts/claude-review.mjs cancel
```

Pass the user's optional job ID separately. Without it, cancellation applies to
the latest job in this checkout. The worker handles the request and terminates
its own Claude process. A request is not confirmation that the process stopped;
check `$claude:status JOB_ID` and report the final state. Do not kill a PID
found in old logs or cancel unrelated jobs.

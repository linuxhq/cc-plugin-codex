---
name: claude-setup
description:
  Check whether the local Claude Code executable and authentication are ready
  for this Codex review plugin.
---

Resolve the plugin root two directories above this skill directory and run:

```sh
node /absolute/plugin/root/scripts/claude-review.mjs setup
```

Use the actual quoted path. This checks the installed CLI and its authentication
without starting a paid review. Report the result. If the executable is missing,
point to `https://code.claude.com/docs/en/setup`. If authentication is missing,
tell the user to run `claude auth login` in their terminal.

Setup does not install software, sign in, change Codex configuration, or enable
hooks. A successful check confirms local credentials exist; a real review may
still encounter provider, network, quota, or model availability errors.

# Keep parity with upstream

This project adapts
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) to run
Claude from Codex. Keep its features, defaults, and workflows aligned with
upstream. Don't add features unless the user explicitly asks.

Before changing behavior, read the matching upstream code at the revision in
`plugins/claude/NOTICE`. Check upstream HEAD when updating that baseline. Leave
the upstream checkout unchanged.

Keep differences limited to what Claude and Codex require. Explain unavoidable
limitations in README, and keep skills, help text, prompts, and tests
consistent. When extra behavior causes a bug, prefer removing it over adding
more machinery. Reviews only review; rescue performs the user's authorized task.

# Finish every change

Follow the local [lint](.agents/skills/lint/SKILL.md),
[format](.agents/skills/format/SKILL.md), and
[test](.agents/skills/test/SKILL.md) skills:

```sh
npm run lint -- --fix
npm run format
npm run check
```

Use `padding-line-between-statements` for blank lines after control-flow blocks,
keeping `else`, `catch`, and `finally` attached. Let Prettier handle other
formatting. Fix failures instead of disabling checks. Tests use the fake Claude
CLI and should not consume Claude usage.

# Releases

Follow the [release](.agents/skills/release/SKILL.md) skill for version bumps
and releases. Publish only after all GitHub CI for the exact release commit,
including branch and tag workflows and every matrix job, passes.

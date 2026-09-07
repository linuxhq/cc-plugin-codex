# Keep parity with upstream

This project adapts
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) to run
Claude from Codex.

- Match upstream features, defaults, workflows, limits, and cleanup policies.
- Change behavior only when Claude running in Codex requires it or the user
  explicitly asks. Explain why each difference is needed.
- Before changing behavior, read the matching upstream code at the revision in
  `plugins/claude/NOTICE`. Check upstream HEAD when updating that baseline.
  Leave the upstream checkout unchanged.
- Prefer small adaptations. If our extra behavior causes a bug, simplify or
  remove it before adding more machinery.
- No legacy support. Remove legacy compatibility code. Do not add migrations,
  compatibility layers, or fallbacks for older versions or data formats. Keep
  race protection and lifecycle handling needed by the current version.
- Verify review findings against upstream and the user's request. Fix real
  defects; do not turn review suggestions into unrequested features.
- Keep README, skills, help text, prompts, and tests consistent. Document
  unavoidable limitations. Correct unsupported promises instead of building
  extra behavior to fulfill them.
- Reviews only review. Rescue performs the user's authorized task.

# Finish every change

Follow the local [lint](.agents/skills/lint/SKILL.md),
[format](.agents/skills/format/SKILL.md), and
[test](.agents/skills/test/SKILL.md) skills. Run:

```sh
npm run lint -- --fix
npm run format
npm run check
```

- Fix failures; do not disable checks.
- Use `padding-line-between-statements` for blank lines after control-flow
  blocks. Keep `else`, `catch`, and `finally` attached.
- Let Prettier handle other formatting.
- Tests must use the fake Claude CLI and must not consume Claude usage.

# Releases

- Follow the [release](.agents/skills/release/SKILL.md) skill for version bumps
  and releases.
- Publish only after all GitHub CI for the exact release commit passes,
  including branch workflows, tag workflows, and every matrix job.

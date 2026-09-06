---
name: lint
description:
  Run ESLint after changes in this repository and fix violations before handing
  work back. Use for every code or lint-configuration edit here.
---

Run from the repository root:

```sh
npm run lint -- --fix
```

Inspect the changes and resolve remaining violations. Preserve upstream
behavior; do not disable rules or add suppressions merely to make the command
pass. `padding-line-between-statements` owns blank lines after control-flow
blocks. Keep declarations and imports grouped according to the configuration.

After Prettier runs, use `npm run lint` to verify the final files. The final
`npm run check` includes this verification, so a passing check satisfies it.
Report an unavailable dependency or failed check accurately.

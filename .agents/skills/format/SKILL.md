---
name: format
description:
  Apply Prettier after repository edits and verify formatting before handing
  work back. Use for every source, documentation, skill, or configuration change
  here.
---

Run from the repository root, after ESLint fixes:

```sh
npm run format
```

Inspect the resulting diff. Keep formatting changes separate from behavior in
review explanations. Do not hand-maintain line wrapping or introduce another
formatter; ESLint owns statement spacing and Prettier owns the remaining style.

Finish with `npm run check`, which includes `npm run format:check`, lint,
plugin/skill validation, and tests. If either formatter changes a file after a
check, verify the changed final files again before reporting success.

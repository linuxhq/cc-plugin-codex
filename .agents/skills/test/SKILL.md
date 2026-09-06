---
name: test
description:
  Run tests after repository changes and verify the full suite before handing
  work back. Use for code, configuration, skill, or documentation changes here.
---

Run from the repository root. During implementation, use relevant tests to check
changed behavior:

```sh
node --test tests/args.test.mjs
```

Use the test files relevant to the change. Add or update tests for behavior
changes and bug fixes, including flags removed for upstream parity. Remove tests
for deleted features rather than keeping those features just to pass old tests.

Before handing work back, run `npm run check`. It includes the full `npm test`
suite along with lint, formatting, and plugin/skill validation. A passing final
check satisfies this skill; don't rerun the suite without a reason.

Tests use temporary repositories and the fake Claude CLI. Do not invoke a real
Claude review or consume provider usage as part of automated testing. Fix
failures and report any checks that could not run. Don't skip tests or weaken
assertions just to get a passing result.

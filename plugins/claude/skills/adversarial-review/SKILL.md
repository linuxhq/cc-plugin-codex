---
name: adversarial-review
description:
  Run a Claude review that challenges the implementation approach and design
  choices
---

Run an adversarial Claude review through the shared plugin runtime. Position it
as a challenge review that questions the chosen implementation, design choices,
tradeoffs, and assumptions. It is not just a stricter pass over implementation
defects.

Arguments:
`[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]`

Use the arguments supplied with this skill invocation.

Core constraint:

- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make
  changes.
- Your only job is to run the review and return Claude's output verbatim to the
  user.
- Keep the framing focused on whether the current approach is the right one,
  what assumptions it depends on, and where the design could fail under
  real-world conditions.

Execution mode rules:

- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run through the
  runtime background worker.
- Otherwise, estimate the review size before asking:
  - In auto scope, review local changes when dirty; otherwise review the branch
    against the detected default branch. `--base` selects branch review, and
    branch scope without a base detects it.
  - For working-tree review, start with
    `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached`
    and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or
    working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually
    empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2
    files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to
    review.
- Then use the available user-question tool exactly once with two options,
  putting the recommended option first and suffixing its label with
  `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:

- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The bundled CLI parses `--wait` and `--background`; `--background` detaches
  the runtime worker.
- If the user selected a mode in the question, append its flag to the supplied
  arguments.
- Resolve the plugin root two directories above this skill directory. Use the
  actual quoted path and pass arguments individually; do not pass a raw
  shell-evaluated argument string.
- `$claude:adversarial-review` uses the same review target selection as
  `$claude:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `$claude:review`, it can still take extra focus text after the flags.

Foreground flow:

- Run:

```bash
node "/absolute/plugin/root/scripts/claude-review.mjs" adversarial-review --wait
```

- The example shows the execution mode; also pass the user's supplied arguments.
- Poll the foreground process until completion.
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:

- Launch the review through the bundled CLI:

```sh
node "/absolute/plugin/root/scripts/claude-review.mjs" adversarial-review --background
```

- Also pass the user's supplied arguments.
- Do not poll the review job or wait for completion in this turn.
- After a successful launch, tell the user: "Claude adversarial review started
  in the background. Check `$claude:status` for progress."
- If the CLI reports an empty scope or a launch failure, return that output
  instead of claiming a review started.

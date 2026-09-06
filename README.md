# Claude Review for Codex

Get a second opinion from Claude without leaving Codex. Review your code for
bugs, challenge a design decision, or have Claude automatically check each turn
before Codex finishes.

Reviews use your local Claude account and count toward its usage limits. The
reviewer can read code, but cannot edit files or run tests.

## Get started

You'll need:

- macOS or Linux, Git, and Node.js 22.13 or later.
- Codex with plugin support.
- [Claude Code][claude-setup] installed and signed in with `claude auth login`.

Install the plugin:

```sh
codex plugin marketplace add linuxhq/cc-plugin-codex
codex plugin add claude@linuxhq
```

Start a new Codex session, then check that everything is ready:

```text
$claude:setup
```

Run your first review:

```text
$claude:review --wait
```

After updating the plugin, start a new session to load the changes.

## Choose a review

**Code review** looks for bugs and regressions in your changes:

```text
$claude:review
$claude:review --base main
```

**Adversarial review** challenges the approach, assumptions, and design choices.
You can give it a specific area to focus on:

```text
$claude:adversarial-review
$claude:adversarial-review --base main examine retry and rollback behavior
```

Both commands return Claude's review without rewriting it or applying fixes.
They run when you explicitly request them.

### Wait or keep working

Use `--wait` to wait for the review, or `--background` to get a job ID and
return immediately. If you omit both flags, Codex asks which you prefer,
recommending background execution for larger changes.

```text
$claude:review --background
$claude:status
$claude:result
```

Status shows elapsed time, the review phase, and recent activity. Add a job ID
for more detail, retrieve a particular review, or cancel it:

```text
$claude:status JOB_ID
$claude:result JOB_ID
$claude:cancel JOB_ID
```

Without an ID, `status` lists the ten latest jobs; `result` and `cancel` use the
latest job in this checkout, across sessions. Background jobs keep running after
a Codex session ends. Check status or results for completion; there are no
background completion notifications.

### What gets reviewed?

By default, Claude reviews your local changes when there are any: staged edits,
unstaged edits, and new files that Git isn't ignoring. If the checkout is clean,
it reviews your committed branch changes against the detected default branch.

To choose the target yourself:

- `--base main`: review changes since the branch diverged from `main`.
- `--scope working-tree`: review only local changes.
- `--scope branch`: review committed branch changes, detecting the base if
  needed.

`--base` takes precedence over `--scope`. Base detection checks origin HEAD,
then `main`, `master`, and `trunk`.

Reviews preserve the patch as it looked at launch. Claude can also read
surrounding files from the live checkout, so later edits may affect that
context. Large diffs are saved as complete private snapshots for Claude to read
in sections. Binary changes are noted, but their contents aren't reviewed.

### Other options

- `--model MODEL`: choose a model instead of Claude's configured default.
- `--effort low|medium|high|xhigh|max`: choose the reasoning effort. Supported
  combinations depend on your Claude CLI and provider.
- `--focus-file PATH`: supply focus text from a file. Adversarial review only.

```text
$claude:review --background --model sonnet
$claude:adversarial-review --wait --focus-file review-focus.md
```

## Review automatically

The optional review gate asks Claude to check changes made during each Codex
turn before Codex finishes. It's off by default.

To enable it:

1. Use a Codex version that supports [UserPromptSubmit and Stop
   hooks][codex-hooks].
2. Start a new session after installing or updating the plugin.
3. Open `/hooks` and review and trust both hooks.
4. Run `$claude:setup --enable-review-gate` in your checkout.

The setting stays enabled across sessions for that checkout. Each Git worktree
has its own setting. Enabling it doesn't grant hook trust or override a Codex
setting that disables hooks.

To check the setting or turn it off:

```text
$claude:setup
$claude:setup --disable-review-gate
```

Disabling works even if Claude is unavailable.

### What happens each turn?

- The gate reviews changes made during the turn, including changes you
  committed. It doesn't send conversation text to Claude.
- If nothing changed, it skips the review. Older uncommitted edits, or simply
  staging or committing those edits, don't trigger a review.
- `ALLOW` lets Codex finish. `BLOCK` sends Codex a short summary of issues that
  still need fixes. Use `$claude:result JOB_ID` to read the full findings.
- Failed, cancelled, or invalid reviews don't count as a pass.
- After a blocking review, the automatic gate skips the continuation to avoid a
  loop. Run `$claude:review --wait` to check the fixes.

The gate skips non-Git directories and reports when it has no starting snapshot.
Changes made by another process during the same turn are included. Automatic
reviews count toward Claude's usage limits and appear as `stop-review-gate` jobs
in status; you can inspect or cancel them like any other review.

## Privacy and storage

Claude gets only the `Read`, `Glob`, and `Grep` tools. The plugin disables
Claude's hooks, skills, MCP tools, and session persistence, and loads user
settings for credentials and model defaults. It doesn't load project or local
Claude settings. These are CLI restrictions, not an operating-system sandbox.

Review data is stored outside your checkout with private file permissions:

```text
~/.codex/plugins/data/claude-review/jobs/
```

This includes prompts, findings, progress, large-diff snapshots, and gate state,
grouped by checkout. The data may contain source code and stays there until you
delete it. Remove old data only after its jobs have finished. Set
`CLAUDE_REVIEW_DATA_DIR` to use another location.

<details>
<summary>Runtime details</summary>

- Explicit reviews have a 20-minute timeout. Automatic reviews have a 14-minute
  timeout inside a 15-minute hook timeout.
- Diffs up to 256 KiB go into the prompt. Larger diffs are streamed to a
  snapshot file. A complete snapshot doesn't guarantee Claude inspected every
  part; the reviewer must report anything it couldn't inspect.
- Adversarial reviews use Claude's `--json-schema` option. The runtime validates
  the `structured_output` result and renders it as Markdown. Missing output and
  schema failures remain failed reviews.
- Progress comes from streamed tool and text events. A separate heartbeat tracks
  worker liveness; a stale heartbeat marks a job as interrupted.
- Cancellation stops the worker's own Claude process. The plugin doesn't set
  `--max-turns` or create resumable Claude sessions.
- Turn snapshots use a separate Git index and object store, leaving your index
  and history untouched.

</details>

## Development

No runtime npm dependencies or build step are needed. For development:

```sh
npm ci
npm run check
npm run format
```

`check` runs linting, formatting checks, plugin and skill validation, and tests.
CI covers macOS and Linux with Node 22 and 24. Tests use temporary Git
repositories and a fake Claude CLI, so they don't consume Claude usage.

To install from a local checkout, run these commands from the repository root:

```sh
codex plugin marketplace add .
codex plugin add claude@linuxhq
```

Start a new Codex session, then run `$claude:setup`.

The plugin lives in `plugins/claude/`. You can also call its CLI directly:

```sh
node /path/to/cc-plugin-codex/plugins/claude/scripts/claude-review.mjs help
```

Direct CLI calls run in the foreground by default. The execution-mode question
is part of the Codex skills.

## Credits and references

The review skills, adversarial prompt, and parts of the runtime are adapted from
[OpenAI's Codex plugin for Claude Code][openai-plugin], with Claude as the
reviewer and execution adapted for Codex. See [NOTICE](plugins/claude/NOTICE)
for the upstream revision and attribution, and [LICENSE](plugins/claude/LICENSE)
for the Apache 2.0 terms covering copied material.

- [Codex plugin documentation][codex-plugins]
- [Codex hooks][codex-hooks]
- [Claude Code CLI reference][claude-cli]

[claude-cli]: https://code.claude.com/docs/en/cli-reference
[claude-setup]: https://code.claude.com/docs/en/setup
[codex-plugins]: https://developers.openai.com/codex/plugins
[codex-hooks]: https://developers.openai.com/codex/hooks
[openai-plugin]: https://github.com/openai/codex-plugin-cc

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

Without an ID, `status` shows active and recent jobs in this session. Use
`--all` for the full session history, or a job ID to look up a specific run.

To wait for an existing job:

```text
$claude:status JOB_ID --wait
```

Waiting times out after four minutes without stopping the review. Use
`--timeout-ms` to change the wait time.

`result` returns the complete output verbatim. Without an ID, it selects the
most recently updated finished job in this session. `cancel` selects the sole
active job in this session; if several are active, pass a job ID. Background
jobs keep running after a Codex session ends; check status or results for
completion. There are no background completion notifications.

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

Claude inspects the selected diff and surrounding code. Small adversarial
reviews include the diff in the prompt; larger ones include a summary and ask
Claude to inspect Git directly. Untracked files over 24 KiB are omitted from the
prompt.

Use `--model MODEL` (or `-m MODEL`) to choose a model:

```text
$claude:review --background --model sonnet
```

## Review automatically

The optional gate asks Claude to review the previous Codex turn before Codex
finishes. It's off by default.

1. Use a Codex version that supports [Stop hooks][codex-hooks].
2. Trust the Stop hook in `/hooks`.
3. Run `$claude:setup --enable-review-gate` in your checkout.

The setting persists per checkout. To turn it off:

```text
$claude:setup --disable-review-gate
```

The gate sends the previous Codex response to Claude. Claude checks the
repository and returns `ALLOW` after successful inspection without blocking
findings, `BLOCK` for issues that need fixing, `SKIP` when no edits need review,
or `INCOMPLETE` when inspection cannot complete. Use `$claude:result JOB_ID` for
full findings.

The gate skips continued Stop turns (`stop_hook_active`) to prevent repeated
blocking. Only a valid blocking verdict stops the turn. Authentication errors,
timeouts, invalid output, and unreadable configuration produce a notice with
recovery guidance. Successful reviews and no-edit skips are silent. Blocked
reviews show only the first-line reason and a `$claude:result JOB_ID` command
for full details. Missing, failed, or truncated inspection produces an
INCOMPLETE notice, even if the model claims ALLOW. Blocking findings and
SKIP/INCOMPLETE explanations are preserved even when inspection fails. Page
boundaries defer whole lines; a single line exceeding the byte limit still
produces incomplete evidence. The runtime checks a private inspection record
written by its MCP server. The verdict uses a validated JSON schema; repository
text remains untrusted evidence, and model review is not a security boundary
against prompt injection.

## Privacy and storage

Claude inspects the checkout through one bundled stdio MCP tool with fixed
operations for file listing, paged reads, diffs, status, and history. It has no
built-in shell or file tools and cannot select arbitrary Git flags. File reads
exclude ignored files, common secret filenames, and symlinks that escape the
checkout. The same secret exclusions apply to diff content at every depth.
Listings, reads, and diffs stream into bounded pages; diffs accept a literal
file filter. Long lines include an explicit truncation marker. The plugin
disables other MCP servers, hooks, skills, and session persistence, and loads
user settings for credentials and model defaults. It doesn't load project or
local Claude settings. These are tool restrictions, not an operating-system
sandbox; source changes included in prompts may contain secrets.

Review data is stored outside your checkout with private file permissions:

```text
~/.codex/plugins/data/claude-review/jobs/
```

This includes prompts, findings, progress, and gate state, grouped by checkout.
The data may contain source code and stays there until you delete it. Remove old
data only after its jobs have finished. Set `CLAUDE_REVIEW_DATA_DIR` to use
another location.

<details>
<summary>Runtime details</summary>

- Automatic reviews have a 10-minute subprocess timeout, leaving five minutes
  within the Stop hook deadline for startup, cleanup, and verdict persistence.
  Explicit reviews run until completion or cancellation.
- Adversarial and automatic reviews use Claude's `--json-schema` option. The
  runtime validates the `structured_output` result and renders it as Markdown.
  Missing output and schema failures remain failed reviews.
- Progress comes from streamed tool and text events. A separate heartbeat tracks
  worker liveness; a stale heartbeat marks a job as interrupted.
- Cancellation stops the worker's own Claude process. The plugin doesn't set
  `--max-turns` or create resumable Claude sessions.

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

For scripts, add `--cwd PATH` (or `-C PATH`) to choose a checkout and `--json`
for machine-readable output. These options work with every command except
`help`.

```sh
node /path/to/claude-review.mjs status JOB_ID --wait --json
```

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

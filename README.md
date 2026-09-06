# Claude Review for Codex

Ask Claude Code to review your changes from inside Codex. Normal and adversarial
reviews share a small runtime with background jobs, stored results, and
cancellation. An optional automatic review gate asks Claude to check a turn
before Codex finishes. Every command starts with `$claude:`.

## Requirements

- Node.js 22.13 or later and Git, on macOS or Linux.
- Codex with plugin support.
- [Claude Code][claude-setup] installed as `claude` and authenticated with
  `claude auth login`.

The plugin uses the local Claude CLI and its credentials. Reviews consume that
account's usage. No runtime npm dependencies or build step are required.

## Install

Add the GitHub marketplace and install the plugin:

```sh
codex plugin marketplace add linuxhq/cc-plugin-codex
codex plugin add claude@linuxhq
```

Start a new Codex session, then run `$claude:setup`.

## Install from this checkout

Run these commands from the repository root:

```sh
codex plugin marketplace add .
codex plugin add claude@linuxhq
```

Start a new Codex session, then run `$claude:setup`. The plugin name is
`claude`; commands use `$claude:<skill-name>` as listed below.

## Commands

| Command                      | Purpose                        |
| ---------------------------- | ------------------------------ |
| `$claude:review`             | Find bugs in Git changes       |
| `$claude:adversarial-review` | Challenge design choices       |
| `$claude:setup`              | Check readiness and gate state |
| `$claude:status [JOB_ID]`    | Show progress and recent jobs  |
| `$claude:result [JOB_ID]`    | Retrieve stored findings       |
| `$claude:cancel [JOB_ID]`    | Request cancellation           |

```text
$claude:review
$claude:review --base main
$claude:review --background --model sonnet
$claude:adversarial-review --base main examine retry and rollback behavior
$claude:status
$claude:result
```

### Review arguments

Both skills are explicitly invoked and review-only: they return the command's
stdout verbatim and do not apply fixes. Normal review checks implementation
defects. Adversarial review challenges the approach, design choices, tradeoffs,
and assumptions; it is not just a stricter correctness pass.

Pass `--wait` or `--background` to choose execution mode directly. Without
either flag, the skill estimates the change size and asks once. It recommends
waiting for clearly tiny changes (roughly one or two files), and background
execution for larger or uncertain scopes. Background execution returns without
polling; use `$claude:status` and `$claude:result` to follow the job.

Both review commands accept:

- `--wait`: wait for the result.
- `--background`: return immediately with a job ID. Cannot be combined with
  `--wait`.
- `--base REF`: review the branch from its merge base with this ref to HEAD.
- `--scope auto|working-tree|branch`: default to `auto`, which selects branch
  review when the checkout is clean and working-tree review when local changes
  exist. Branch scope detects the default base if none is given. `--base` takes
  precedence over scope; explicit `working-tree` without a base reviews only
  local changes. Base detection checks origin HEAD, then main, master, and
  trunk.
- `--model MODEL`: override Claude's configured model.
- `--effort low|medium|high|xhigh|max`: override Claude's configured effort.
  Supported model and effort combinations depend on the installed CLI and
  provider.

Only `$claude:adversarial-review` accepts custom focus text, either as
positional arguments or through `--focus-file PATH`.

Adversarial reviews pass the upstream structured output schema through Claude's
`--json-schema` flag. The runtime requires the `structured_output` result field,
validates it, and renders findings in upstream's Markdown layout. Missing
output, schema retry failures, and invalid data are reported as failed reviews.

### Review scope and jobs

- Working-tree reviews include staged and unstaged patches plus nonignored
  untracked files, even before the first commit. Ignored files are excluded.
- Binary changes are identified, but their contents are not reviewed.
- Context up to 256 KiB is included in the prompt. Larger diffs are streamed to
  a complete private snapshot that Claude can read in sections with Read and
  Grep. This applies to working-tree, branch, and automatic turn reviews.
- Without a job ID, `result` and `cancel` select the latest job in this checkout
  across Codex sessions. `status` lists the ten latest jobs. Use an explicit ID
  when multiple sessions are active.
- Separate Git worktrees have separate job stores.
- Background reviews snapshot the patch at launch, but supporting file reads use
  the live checkout. Avoid changing the checkout during a review when consistent
  surrounding context matters.

`$claude:status` shows elapsed time (or final duration), the current phase, a
short activity summary, and the last progress update. Pass a job ID to see the
five most recent activity previews. Progress comes from Claude's streamed tool
and text events; it does not indicate that a review passed. A heartbeat confirms
worker liveness separately from progress updates.

## Automatic review gate

Like OpenAI's Codex plugin for Claude Code, this plugin bundles a `Stop` hook
with an opt-in setting for each Git checkout:

```text
$claude:setup --enable-review-gate
$claude:setup --disable-review-gate
```

The gate is disabled by default. Setup without flags reports its state and
checks Claude authentication. Enabling checks authentication before saving the
setting; disabling works even when Claude is unavailable.

To activate the gate:

1. Use a Codex version with [UserPromptSubmit and Stop hooks][codex-hooks].
2. Start a new session after installing or updating the plugin.
3. Review and trust both hooks in `/hooks`.
4. Run `$claude:setup --enable-review-gate` in the checkout.

Codex skips untrusted hooks. Enabling the gate does not change hook trust or
override a global or administrator setting that disables hooks.

At UserPromptSubmit, the hook snapshots the checkout's file contents for the
session and turn. At Stop, it compares the current contents with that snapshot.
If nothing changed, it skips Claude even when older uncommitted edits exist.
Otherwise, Claude receives only the turn's Git diff, without conversation text,
and can inspect surrounding files with read-only tools. Edits committed during
the turn are included; staging or committing existing edits alone does not
trigger a review. Snapshots use a separate index and object store in the plugin
data directory, leaving the checkout's index and history untouched.

If the starting snapshot is missing, the hook skips with an explanatory message
instead of reviewing older changes. Concurrent external edits during the same
turn are included: the comparison identifies when contents changed, not who
edited them. Ignored untracked files are excluded.

Review outcomes:

- `ALLOW` lets Codex finish.
- `BLOCK` reports that issues still need fixes, followed by the reviewer's
  first-line summary and job ID. Use `$claude:result JOB_ID` for full findings.
- Failed, cancelled, and malformed reviews return feedback instead of counting
  as a pass. Failure messages separate the error, job ID, and recovery commands
  onto individual lines.
- A continuation triggered by a Stop hook skips automatic review to prevent
  endless loops. Run `$claude:review` to verify fixes.
- Non-Git directories skip review.

Automatic runs consume Claude account usage, including when Claude decides a
turn needs no further review. They use Claude's configured model and effort,
have a 14-minute review timeout inside a 15-minute hook timeout, and appear as
`stop-review-gate` jobs in `$claude:status`. Use `$claude:result JOB_ID` for the
full decision or `$claude:cancel JOB_ID` to cancel a running review. The
reviewer's own Claude hooks are disabled to avoid recursive reviews.

## Execution and storage

The runtime calls `claude --print` with only `Read`, `Glob`, and `Grep`
available. It disables hooks, slash commands, session persistence, and MCP
tools. It loads user settings for credentials and model defaults, while
excluding project and local settings. It never grants Bash, Edit, Write, or
subagent tools. These are CLI tool restrictions, not an operating-system
sandbox; the host's permissions still apply. Claude cannot execute tests during
these reviews.

Explicit reviews get a fresh process and a 20-minute timeout. The plugin does
not set `--max-turns`; turn limits are left to Claude Code. Background workers
update a heartbeat and handle cancellation requests by stopping their own Claude
child. A missing heartbeat marks a job as interrupted rather than successful.
Jobs continue when a Codex thread ends; use the job ID to cancel them
explicitly. There are no background completion notifications; status and result
are the supported way to check background work.

Prompts, findings, progress, large-diff snapshots, and job metadata are stored
with private file permissions under `~/.codex/plugins/data/claude-review/jobs/`,
grouped by repository path. Set `CLAUDE_REVIEW_DATA_DIR` to choose another
writable location. Artifacts may contain source code and are retained until you
delete them; remove old job directories after their workers finish. They are
never written into the reviewed checkout. The gate setting is stored as
`gate.json` in the same checkout-specific data directory. Separate worktrees
have independent gate settings.

## Development

```sh
npm ci
npm run check
npm run format
```

`check` runs ESLint, Prettier verification, plugin and skill validation, and
Node's test runner. ESLint limits function size, complexity, and nesting. CI
runs on macOS and Linux with Node 22 and 24. Integration tests use real
temporary Git repositories and a fake Claude CLI, requiring no account or model
calls.

The CLI can also be used directly from any repository:

```sh
node /path/to/cc-plugin-codex/plugins/claude/scripts/claude-review.mjs help
```

Direct CLI calls default to foreground execution; the mode-selection question
belongs to the skills in Codex.

The distributable plugin lives in `plugins/claude/`. Skills describe the
commands; `scripts/lib/` contains focused modules for arguments, Git context,
subprocesses, Claude invocation, job storage, and worker execution. Review
prompts live in `prompts/`.

## References

The two review skills and adversarial prompt are adapted from [OpenAI's Codex
plugin for Claude Code][openai-plugin]. Their wording and review workflow follow
upstream, with Claude names, Codex skill metadata, and host execution tools
substituted. Claude provides the normal correctness review in place of Codex's
native reviewer. Background jobs use this plugin's worker instead of Claude
Code's background-task tool. Provider-specific options remain available.

Source attribution, the pinned upstream revision, and adaptation details are in
[`plugins/claude/NOTICE`](plugins/claude/NOTICE); copied material retains its
Apache 2.0 license in [`plugins/claude/LICENSE`](plugins/claude/LICENSE).

Packaging follows [Codex plugin documentation][codex-plugins]. Claude invocation
follows the [Claude Code CLI reference][claude-cli].

[claude-cli]: https://code.claude.com/docs/en/cli-reference
[claude-setup]: https://code.claude.com/docs/en/setup
[codex-plugins]: https://developers.openai.com/codex/plugins
[codex-hooks]: https://developers.openai.com/codex/hooks
[openai-plugin]: https://github.com/openai/codex-plugin-cc

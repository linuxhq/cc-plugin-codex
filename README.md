# Claude Review for Codex

Ask Claude Code to review your changes from inside Codex. Normal and adversarial
reviews share a small runtime with background jobs, stored results, and
cancellation. Every command starts with `$claude-`.

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
codex plugin add cc-plugin-codex@linuxhq
```

Start a new Codex session, then run `$claude-setup`.

## Install from this checkout

Run these commands from the repository root:

```sh
codex plugin marketplace add .
codex plugin add cc-plugin-codex@linuxhq
```

Start a new Codex session, then run `$claude-setup`. Codex may display the
plugin namespace alongside each skill in its picker; the skill names themselves
are `claude-review`, `claude-setup`, and the other names listed below.

## Commands

| Command                      | Purpose                       |
| ---------------------------- | ----------------------------- |
| `$claude-review`             | Find bugs in Git changes      |
| `$claude-adversarial-review` | Challenge design choices      |
| `$claude-setup`              | Check CLI and authentication  |
| `$claude-status [JOB_ID]`    | Show progress and recent jobs |
| `$claude-result [JOB_ID]`    | Retrieve stored findings      |
| `$claude-cancel [JOB_ID]`    | Request cancellation          |

```text
$claude-review
$claude-review --base main
$claude-review --background --model sonnet
$claude-adversarial-review --base main examine retry and rollback behavior
$claude-status
$claude-result
```

Reviews wait by default. Pass `--background` to return immediately with a job
ID, or `--wait` to explicitly wait. Both review commands accept `--model MODEL`
and `--effort low|medium|high|xhigh|max`. Omitted model and effort options are
left to Claude; model and effort compatibility is determined by the installed
CLI and provider. Focus text is supported only by adversarial review, either as
positional arguments or with `--focus-file PATH`.

`--scope auto` is the default: `--base REF` selects branch review; otherwise
review the working tree. `--scope branch` requires `--base`;
`--scope working-tree` rejects it. Branch reviews compare the merge base to HEAD
and require clean tracked files so Claude's file reads match the diff.
Working-tree reviews include separate staged and unstaged patches plus
nonignored untracked files, even before the first commit. Ignored files are not
included in the supplied patch. Binary changes are identified but their contents
are not reviewed. Context over 1 MiB is rejected before calling Claude; split
large changes into smaller reviews.

Without an ID, result and cancel select the latest job in this checkout, across
Codex sessions. Use an explicit ID when multiple sessions are active. Separate
Git worktrees have separate job stores. Background reviews snapshot the patch at
launch; supporting file reads use the live checkout. Avoid changing the checkout
during a review when consistent surrounding context matters.

## Execution and storage

The runtime calls `claude --print` with only `Read`, `Glob`, and `Grep`
available. It disables hooks, slash commands, session persistence, and MCP
tools. It loads user settings for credentials and model defaults, while
excluding project and local settings. It never grants Bash, Edit, Write, or
subagent tools. These are CLI tool restrictions, not an operating-system
sandbox; the host's permissions still apply. Claude cannot execute tests during
these reviews.

Every review gets a fresh process and a 20-minute timeout. The plugin does not
set `--max-turns`; turn limits are left to Claude Code. Background workers
update a heartbeat and handle cancellation requests by stopping their own Claude
child. A missing heartbeat marks a job as interrupted rather than successful.
Jobs continue when a Codex thread ends; use the job ID to cancel them
explicitly. There are no automatic review hooks or completion notifications;
status and result are the supported way to check background work.

Prompts, findings, and job metadata are stored with private file permissions
under `~/.codex/plugins/data/claude-review/jobs/`, grouped by repository path.
Set `CLAUDE_REVIEW_DATA_DIR` to choose another writable location. Artifacts may
contain source code and are retained until you delete them; remove old job
directories after their workers finish. They are never written into the reviewed
checkout.

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
node /path/to/cc-plugin-codex/plugins/cc-plugin-codex/scripts/claude-review.mjs help
```

The distributable plugin lives in `plugins/cc-plugin-codex/`. Skills describe
the commands; `scripts/lib/` contains focused modules for arguments, Git
context, subprocesses, Claude invocation, job storage, and worker execution.
Review prompts live in `prompts/`.

## References

The layout and review workflows are inspired by [OpenAI's Codex plugin for
Claude Code][openai-plugin]. This project is an independent implementation
focused on reviews.

Packaging follows [Codex plugin documentation][codex-plugins]. Claude invocation
follows the [Claude Code CLI reference][claude-cli].

[claude-cli]: https://code.claude.com/docs/en/cli-reference
[claude-setup]: https://code.claude.com/docs/en/setup
[codex-plugins]: https://developers.openai.com/codex/plugins
[openai-plugin]: https://github.com/openai/codex-plugin-cc

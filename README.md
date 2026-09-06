# Claude for Codex

Use Claude from Codex for code reviews, adversarial reviews, delegated work, and
conversation handoff. This is an adaptation of [OpenAI's Codex plugin for Claude
Code][upstream], with the same feature scope. The baseline revision is recorded
in [NOTICE](plugins/claude/NOTICE).

Reviews use your local Claude account and count toward its usage limits.

## Setup

Requirements: macOS or Linux, Git, Node.js 22.13 or later, Codex with plugin
support, and [Claude Code][claude-setup] authenticated with `claude auth login`.
Write rescue uses Claude's sandbox; Linux also needs its sandbox dependencies
(`bubblewrap` and `socat`).

```sh
codex plugin marketplace add linuxhq/cc-plugin-codex
codex plugin add claude@linuxhq
```

Start a new Codex session, then run:

```text
$claude:setup
```

If Claude is missing, setup points to the official installation instructions. It
checks readiness and toggles the gate; it does not install software or start a
review. Authentication remains a terminal step. Start a new session after
updating the plugin.

## Reviews

```text
$claude:review
$claude:review --base main --wait
$claude:adversarial-review --background question the retry design
```

Code review checks implementation defects. Adversarial review challenges the
approach, assumptions, tradeoffs, and failure modes. Both are read-only and
return the reviewer's output without applying fixes. Only adversarial review
accepts custom focus text.

The default `--scope auto` reviews staged, unstaged, and untracked changes when
the checkout is dirty; otherwise it reviews the branch against the detected
default branch. `--scope working-tree` and `--scope branch` select the scope
explicitly. `--base REF` selects branch review and takes precedence over scope.
Small adversarial reviews include the diff; larger reviews provide a summary and
ask Claude to inspect the diff directly.

Use `--wait` for foreground execution or `--background` to return a job ID.
Without either flag, the skill asks once, recommending waiting for clearly tiny
changes and background execution otherwise.

## Rescue

```text
$claude:rescue investigate the regression
$claude:rescue --write fix the regression and run the tests
$claude:rescue --resume apply the top fix
$claude:rescue --fresh investigate a different problem
```

The skill adds `--write` for implementation requests and leaves investigations
read-only. Direct CLI rescue is read-only unless `--write` is supplied. Write
rescue uses Claude's built-in file tools and sandboxed Bash to edit and test.
Hooks are disabled in every mode. Claude's permissions and sandbox govern
execution; this plugin does not provide a custom writer, backups, or a write
lock. Configuration and build scripts are code and can be part of an authorized
implementation task, as in upstream.

Rescue defaults to foreground and honors `--background` and `--wait`.
`--prompt-file PATH` supplies multiline task text. `--resume` (also
`--resume-last`) continues the latest resumable rescue in this checkout and
Codex session; `--fresh` starts a new conversation. Without an explicit choice,
the skill asks whether to continue when a candidate exists. Resume continues the
original Claude session. Results include its interactive resume command.

Reviews and rescue accept `--model MODEL` (`-m`). Rescue also accepts
`--effort low|medium|high|xhigh|max`. Omitted values preserve Claude's defaults;
supported values depend on the Claude model.

## Transfer

```text
$claude:transfer
$claude:transfer --source /path/to/codex-session.jsonl
```

Transfer locates the current Codex transcript using the session ID under
`CODEX_HOME` (default `~/.codex`) and returns `claude --resume SESSION_ID`.

Claude lacks upstream's native external-session import API. This adapter makes a
paid call with tools disabled to seed user/assistant text into one persistent
Claude turn. Tool outputs, reasoning, system messages, images, and attachments
are omitted. It does not execute tasks in the transcript. Inputs over 8 MiB are
rejected, and the source remains unchanged.

## Status, results, and cancellation

```text
$claude:status
$claude:status JOB_ID --wait
$claude:result JOB_ID
$claude:cancel JOB_ID
```

Status shows active and recent jobs in the current session; `--all` expands
history. An explicit job ID can select a job from another session in the same
checkout. Waiting defaults to four minutes without stopping the job; use
`--timeout-ms` and `--poll-interval-ms` to adjust it.

Without an ID, result selects the latest finished job; cancel selects the sole
active job and asks for an ID if several are active. Cancellation can leave
partial edits from write rescue. Inspect the working tree before continuing.
Background jobs continue after the launching Codex turn ends.

## Automatic review gate

```text
$claude:setup --enable-review-gate
$claude:setup --disable-review-gate
```

The optional gate is off by default and persists per checkout. Trust its Stop
hook in `/hooks` and start a new session after installing or updating the
plugin.

The gate reviews the previous Codex turn, including whether its design should
ship. It uses upstream's `ALLOW: <reason>` / `BLOCK: <reason>` contract.
Reporting-only turns can return ALLOW without repository inspection. There is no
repository snapshot cache or continued-turn exemption. Unexpected output and
failed reviews block with manual-review guidance; unavailable or unauthenticated
Claude produces setup guidance. Gate jobs appear in status, result, and cancel.

## Host and provider adaptations

The commands, workflows, review scope, and prompts track upstream. Necessary
implementation differences are:

- Codex skills and hook output replace Claude Code slash commands and hooks.
- Claude CLI authentication, model names, effort values, and streamed results
  replace the Codex app-server API. Gate execution leaves one minute inside the
  15-minute hook deadline for cleanup.
- Read-only review and rescue use a bundled inspection MCP tool because Claude
  does not expose Codex's read-only workspace sandbox. The tool supports bounded
  file reads, listings, Git diffs, status, and history. It excludes ignored
  files, common secret paths, and escaping symlinks. It cannot run tests.
- Write rescue uses Claude's native tools and sandbox. Unsandboxed retries are
  disabled and unavailable sandbox support fails the run. User and managed
  permission settings still apply; these are different from Codex's sandbox.
- Background execution uses a detached Node worker. The launcher saves a private
  prompt file and returns after spawning; the worker owns execution state and
  deletes the prompt after reading it. Startup/execution errors appear in job
  results or the worker log. There is no prompt acknowledgment deadline.
- Conversation transfer seeds context instead of importing native turns, as
  described above.

Runtime records are stored outside the checkout under
`~/.codex/plugins/data/claude-review/jobs/`, grouped by checkout, with private
permissions. The store keeps 50 finished jobs and preserves active workers.
`CLAUDE_REVIEW_DATA_DIR` overrides that location. Records and Claude's
persistent rescue/transfer sessions can contain source code. Review restrictions
are not an operating-system sandbox. Review supplied content before sending it;
transcripts and output may retain it.

## Development

Follow [AGENTS.md](AGENTS.md) and the local lint, format, and test skills.

```sh
npm ci
npm run lint -- --fix
npm run format
npm run check
```

`check` runs lint, formatting checks, plugin/skill validation, and tests using a
fake Claude CLI. Tests do not consume Claude usage. The plugin lives in
`plugins/claude/`; direct CLI help is available with:

```sh
node plugins/claude/scripts/claude-review.mjs help
```

Commands accept `--cwd PATH` (`-C`) and `--json`, except `help`. Direct review
CLI calls default to foreground; the execution-mode question belongs to skills.

When updating parity, inspect the corresponding upstream command, agent, prompt,
and runtime at the revision in NOTICE. Do not add features absent upstream.
Document provider limitations rather than hiding them behind new modes.

[upstream]: https://github.com/openai/codex-plugin-cc
[claude-setup]: https://code.claude.com/docs/en/setup

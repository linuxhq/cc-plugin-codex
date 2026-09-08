# Claude for Codex

Use Claude from Codex for code reviews, delegated work, and conversation
handoff. This plugin adapts [OpenAI's Codex plugin for Claude Code][upstream];
the tracked revision is in [NOTICE](plugins/claude/NOTICE).

Claude runs use your local account and count toward its usage limits.

## Setup

### Requirements

- macOS or Linux, Git, Node.js 22.13 or later, and `ps`.
- Codex with plugin and hook support.
- [Claude Code][claude-setup], authenticated with `claude auth login`.
- For write rescue on Linux, Claude's sandbox dependencies: `bubblewrap` and
  `socat`.

### Installation

```sh
codex plugin marketplace add linuxhq/cc-plugin-codex
codex plugin add claude@linuxhq
```

- Start a new Codex session and run `$claude:setup`. Setup checks Node, npm,
  Claude, and authentication.
- If Claude is missing and npm is available, the skill can install it with your
  approval. Authentication remains a terminal step.
- Trust the plugin hooks in `/hooks`.
- Start a new session after plugin updates.

## Reviews

```text
$claude:review
$claude:review --base main --wait
$claude:adversarial-review --background question the retry design
```

- **Review** finds implementation defects.
- **Adversarial review** challenges design choices, assumptions, and failure
  modes. It also accepts focus text.
- Both are read-only and return findings without applying fixes.
- A completed job can still report malformed review output or inspection
  limitations.

### Scope

- `--scope auto` reviews staged, unstaged, and untracked changes when dirty.
  Otherwise it reviews the branch against the detected default branch.
- `--scope working-tree` or `--scope branch` selects the scope explicitly.
- `--base REF` selects branch review and takes precedence over scope.
- Default-branch detection uses the remote ref named by `origin/HEAD`, even
  without a matching local branch. This deliberately corrects upstream's
  local-branch lookup.

### Execution

- `--wait` runs in the foreground.
- `--background` returns a job ID.
- Without either flag, the skill asks once. It recommends waiting for tiny
  changes and background execution otherwise.

## Rescue

```text
$claude:rescue investigate the regression
$claude:rescue --write fix the regression and run the tests
$claude:rescue --resume apply the top fix
$claude:rescue --fresh investigate a different problem
```

- The skill adds `--write` for implementation requests and keeps investigations
  read-only. Direct CLI calls require `--write` to edit and test.
- Rescue defaults to foreground and accepts `--wait` or `--background`.

### Continuation

- `--resume` (or `--resume-last`) continues the latest resumable rescue or gate
  task in this checkout and Codex session.
- Failed and cancelled tasks can be resumed when they have a Claude session ID.
- Active rescue or gate tasks must finish first.
- `--fresh` starts a new conversation.
- Without an explicit choice, the skill asks whether to continue when a
  candidate exists.
- Results include `claude --resume SESSION_ID` for interactive continuation.
  Keep that command if you need it later: automatic discovery depends on
  retained job records.
- Outside a Codex session, discovery uses checkout history.

## Transfer

```text
$claude:transfer
$claude:transfer --source /path/to/codex/session.jsonl
```

- Transfer locates the current transcript under `CODEX_HOME` (default
  `~/.codex`) using the Codex session ID.
- Explicit JSONL sources must resolve under its `sessions` or
  `archived_sessions` directory.

### Imported content and limits

- Claude has no native external-session importer. Transfer makes a paid call
  with tools disabled to seed user/assistant text into a persistent
  conversation.
- It returns `claude --resume SESSION_ID` without executing transcript tasks or
  changing the source.
- Tool outputs, reasoning, system messages, images, and attachments are omitted.
- Claude's context limits apply.

## Status, results, and cancellation

```text
$claude:status
$claude:status JOB_ID --wait
$claude:result JOB_ID
$claude:cancel JOB_ID
```

### Finding jobs

- Status shows active and recent jobs in the current session. `--all` expands
  history.
- An explicit ID can select another session's job in the same checkout.
- `status JOB_ID --wait` waits up to four minutes without stopping the job.
  Adjust it with `--timeout-ms` and `--poll-interval-ms` (default 2000 ms).
- Without an ID, result selects the latest finished job.

### Cancellation

- Without an ID, cancel selects the sole active job. Specify an ID when several
  jobs are active.
- Cancellation or failure of write rescue can leave partial edits. Inspect the
  working tree before continuing.

## Logs, history, and cleanup

### Logs and storage

- Foreground activity streams to stderr unless `--json` is selected.
- Each job retains an activity and result log. Its status shows the path.
- Unlike upstream, a final log append tolerates concurrent removal by cleanup.
  Other logging errors still propagate.
- Records use private permissions under
  `~/.codex/plugins/data/claude-review/jobs/`, grouped by checkout.
- `CLAUDE_REVIEW_DATA_DIR` overrides the data directory.
- Records and persistent Claude conversations can contain source code.

### Retention and session cleanup

- History retains the 50 most recently updated jobs and their logs.
- Pruning history neither cancels work nor stops its helpers.
- Background jobs survive the launching turn.
- At SessionEnd, the hook removes finished records and requests cancellation of
  active jobs and their helpers.
- Workers remove their records after stopping. An unresponsive worker can leave
  records behind.
- Other sessions and gate settings are preserved.
- Codex gives SessionEnd three seconds, compared with upstream's five seconds.

### Process failures

- Claude's CLI needs a process supervisor in place of upstream's app-server
  transport. The supervisor reports output failures to the worker before
  stopping Claude and its helpers.
- Failure reporting allows up to one second for diagnostic delivery before
  force-kill. The parent also escalates after receiving an error.
- If delivery fails and the supervisor exits on a signal, the job reports an
  unexpected supervisor exit.
- Ordinary repeated termination signals preserve the shutdown grace period. A
  termination signal during failure reporting stops the group immediately.

## Automatic review gate

```text
$claude:setup --enable-review-gate
$claude:setup --disable-review-gate
```

- The gate is off by default and persists per checkout.
- Setup saves gate changes even if Claude is unavailable or unauthenticated.
- It reviews the previous Codex turn's code changes and design, returning
  `ALLOW:` or `BLOCK:`.
- Reporting turns can pass without inspection.
- Gate jobs support status, result, cancellation, and rescue continuation.

### Verdicts and failures

- The verdict belongs on the first line.
- As a Claude adaptation, a single final-line verdict with a reason is also
  accepted after unfenced prose.
- Missing, multiple, or unsupported verdict formats block the gate.
- Unlike upstream, count uppercase whole words `ALLOW` and `BLOCK` everywhere,
  including prose and code examples. No colon is required for detection.
- Any `BLOCK` blocks. Prefer the canonical first- or final-line reason;
  otherwise report the first detected blocking reason.
- Passing requires exactly one `ALLOW` and the verdict format described above.
- Lowercase words and identifiers such as `BLOCK_SIZE` do not count.
- Quoted uppercase verdict words can cause false blocks. This is deliberate.
- Failed reviews and unexpected output block with manual-review guidance.
- Unavailable Claude produces setup guidance.

## Options and limitations

### Models and input

- Reviews and rescue accept `--model MODEL` (`-m`).
- Rescue also accepts `--effort low|medium|high|xhigh|max`, subject to model
  support.
- Omitted or empty selections preserve Claude's defaults.
- Rescue accepts `--prompt-file PATH`, which takes precedence over task text.
- With neither a prompt file nor task text, the rescue CLI reads piped stdin.
- Relative input paths resolve from the invocation directory or `--cwd`.

### Argument handling

- Rescue and adversarial review keep unknown options as task or focus text. Use
  `--` before text to keep recognized option names literal too.
- Commands accept `--cwd PATH` (`-C`) and `--json`, except `help`.
- Boolean flags accept explicit values. Only `=false` disables them.
- Direct review CLI calls default to foreground.

### Workspace

- Diff reviews require Git.
- Outside Git, other commands use the current directory as their workspace.

### Read-only access

- Read-only runs use a bundled repository inspection tool and disable hooks and
  extensions.
- Read-only runs can read files, diffs, status, and history within the checkout.
  They cannot run tests or use external research tools.
- Explicit reads can access ignored files. These restrictions are not an
  operating-system sandbox.

### Write access

- Write rescue uses Claude's normal tools, settings, hooks, skills, and MCP
  configuration.
- Bash must run sandboxed. Unavailable sandbox support fails the run.
- Provider permissions still apply. The Bash sandbox does not govern hooks or
  MCP tools.
- The plugin supplies no backups or write lock.

### Provider differences

- Claude's prompts and CLI replace upstream's native review and app-server APIs.
  Review quality and sandbox behavior can differ.

## Direct CLI usage

```sh
node plugins/claude/scripts/claude-review.mjs help
```

Contributor instructions and implementation constraints are in
[AGENTS.md](AGENTS.md).

[upstream]: https://github.com/openai/codex-plugin-cc
[claude-setup]: https://code.claude.com/docs/en/setup

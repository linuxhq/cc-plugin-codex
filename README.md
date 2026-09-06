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

Setup reports Node, npm, Claude, and authentication readiness. If Claude is
unavailable and npm is available, the setup skill offers to install it with
`npm install -g @anthropic-ai/claude-code`, then checks readiness again. The
setup CLI only reports readiness and toggles the gate. If npm is unavailable, it
points to the official installation instructions. Authentication remains a
terminal step. Start a new session after updating the plugin.

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

Adversarial results use upstream's finding normalization and display malformed
review shapes with the raw output. The job status reflects provider execution; a
completed job can still contain review-format diagnostics.

The default `--scope auto` reviews staged, unstaged, and untracked changes when
the checkout is dirty; otherwise it reviews the branch against the detected
default branch. `--scope working-tree` and `--scope branch` select the scope
explicitly. `--base REF` selects branch review and takes precedence over scope.
When origin HEAD is available, its remote branch is used even if no matching
local branch exists; this corrects a bug in the pinned upstream baseline. Small
adversarial reviews include the diff; larger reviews provide a summary and ask
Claude to inspect the diff directly.

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
`--prompt-file PATH` supplies multiline task text from an explicit file without
location or filename filtering. Piped stdin supplies the task when neither task
text nor a prompt file is given. Relative input paths resolve from the
invocation directory (or `--cwd`), and a prompt file takes precedence over task
text. `--resume` (also `--resume-last`) continues the latest resumable rescue or
gate task in this checkout and Codex session; outside a host session it searches
this checkout's jobs. Failed and cancelled tasks remain resumable when Claude
supplied a session ID. Resume refuses to start while another rescue or gate is
active; `--fresh` starts a new conversation. Without an explicit choice, the
skill asks whether to continue when a candidate exists. Resume continues the
original Claude session. Results include its interactive resume command.
Automatic resume discovery depends on retained job records: Claude has no
equivalent to upstream's named-task listing API. After records are removed, use
a previously saved `claude --resume SESSION_ID` command to continue directly.

Reviews and rescue accept `--model MODEL` (`-m`). Rescue also accepts
`--effort low|medium|high|xhigh|max`. Omitted values preserve Claude's defaults;
supported values depend on the Claude model. Model names are trimmed; effort
names are trimmed and case-insensitive. Empty model or effort selections
preserve provider defaults, matching upstream.

## Transfer

```text
$claude:transfer
$claude:transfer --source ~/.codex/sessions/2026/09/06/rollout-SESSION_ID.jsonl
```

Transfer locates the current Codex transcript using the session ID under
`CODEX_HOME` (default `~/.codex`) and returns `claude --resume SESSION_ID`.
Explicit sources must resolve to JSONL files under `CODEX_HOME/sessions` or
`CODEX_HOME/archived_sessions`, matching upstream's host-transcript restriction.

Claude lacks upstream's native external-session import API. This adapter makes a
paid call with tools disabled to seed user/assistant text into one persistent
Claude turn. Tool outputs, reasoning, system messages, images, and attachments
are omitted. It does not execute tasks in the transcript, and the source remains
unchanged. Claude's context limits still apply.

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
`--timeout-ms` and `--poll-interval-ms` to adjust it. As upstream does, zero or
nonnumeric timing values select the defaults. Negative timeouts become zero, and
nonzero polling intervals below 100 ms become 100 ms. Timing flags have no
effect without `--wait`.

Without an ID, result selects the latest finished job; cancel selects the sole
active job and asks for an ID if several are active. Cancellation can leave
partial edits from write rescue. Inspect the working tree before continuing.
Background jobs continue after the launching Codex turn ends. When the Codex
session ends, the SessionEnd hook removes its finished job records and cancels
active jobs. Workers remove their records after stopping. Other sessions and the
checkout's gate setting are preserved. The hook uses Codex's maximum SessionEnd
timeout of 3 seconds, rather than upstream's 5 seconds.

## Automatic review gate

```text
$claude:setup --enable-review-gate
$claude:setup --disable-review-gate
```

The optional gate is off by default and persists per checkout. Trust its Stop
hook in `/hooks` and start a new session after installing or updating the
plugin.

Outside Git, rescue, transfer, setup, and job commands use the current directory
as their workspace. Gate settings and jobs remain scoped to that directory. The
two diff-review commands require a Git checkout.

The gate reviews the previous Codex turn, including whether its design should
ship. It uses upstream's `ALLOW: <reason>` / `BLOCK: <reason>` contract.
Reporting-only turns can return ALLOW without repository inspection. There is no
repository snapshot cache or continued-turn exemption. Unexpected output and
failed reviews, including authentication failures, block with manual-review
guidance; unavailable Claude produces setup guidance. Gate jobs appear in
status, result, and cancel. Like upstream, gate tasks persist a resumable
provider session and can be selected by rescue continuation. Missing or
unreadable gate settings use upstream's disabled default. Invalid hook input
reports a hook error; it does not synthesize a blocking review.

## Host and provider adaptations

The commands, workflows, review scope, and prompts track upstream. Necessary
implementation differences are:

- Codex skills and hook output replace Claude Code slash commands and hooks.
- The rescue skill invokes the runtime directly because Codex plugins do not
  provide upstream's named Claude Code subagent type. Its forwarding and result
  handling rules live in the command skill; GPT-specific prompting guidance and
  the `spark` model alias do not apply to Claude.
- Normal review uses a correctness prompt because Claude has no equivalent to
  Codex's native reviewer API. Review quality cannot be guaranteed identical.
- Claude CLI authentication, model names, effort values, and streamed results
  replace the Codex app-server API. Gate execution leaves one minute inside the
  15-minute hook deadline for cleanup.
- Read-only review and rescue use a bundled inspection MCP tool because Claude
  does not expose Codex's read-only workspace sandbox. The tool supports bounded
  file reads, listings, Git diffs, status, and history. Listings omit ignored
  files, but explicit reads can inspect them. Reads stay inside the checkout;
  there is no filename-based filtering. It cannot run tests or access external
  research tools, unlike upstream's read-only Codex sandbox.
- Write rescue uses Claude's native tools and sandbox. Unsandboxed retries are
  disabled and unavailable sandbox support fails the run. User and managed
  permission settings still apply; these are different from Codex's sandbox.
- Background execution uses a detached Node worker. The launcher saves a private
  prompt file and returns after spawning; the worker owns execution state and
  deletes the prompt after reading it. All Claude runs use a process supervisor
  that stops Claude if its owning worker dies. Startup/execution errors appear
  in job results or the worker log. There is no prompt acknowledgment deadline.
- Conversation transfer seeds context instead of importing native turns, as
  described above.

Runtime records are stored outside the checkout under
`~/.codex/plugins/data/claude-review/jobs/`, grouped by checkout, with private
permissions. History uses a 50-job budget, keeping the most recently updated
finished jobs after counting unfinished jobs. Interrupted records are eligible
for pruning. Active worker records are never pruned because workers need them
for cancellation and completion. At least one finished result is retained even
when active workers fill the budget, so the latest completion remains
retrievable; this can exceed the 50-job budget. `CLAUDE_REVIEW_DATA_DIR`
overrides that location. Records and Claude's persistent rescue, gate, and
transfer sessions can contain source code. Review restrictions are not an
operating-system sandbox. Review supplied content before sending it; transcripts
and output may retain it.

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
Boolean flags accept explicit values such as `--json=false`; as upstream does,
only the exact value `false` disables a flag. Use `--` before literal task text
that starts with a dash.

When updating parity, inspect the corresponding upstream command, agent, prompt,
and runtime at the revision in NOTICE. Do not add features absent upstream.
Document provider limitations rather than hiding them behind new modes.

[upstream]: https://github.com/openai/codex-plugin-cc
[claude-setup]: https://code.claude.com/docs/en/setup

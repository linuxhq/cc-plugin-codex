# Claude Review for Codex

Get a second opinion from Claude without leaving Codex. Review your code for
bugs, challenge a design decision, or have Claude automatically check each turn
before Codex finishes. Delegate investigations and fixes, or hand off the
conversation to a persistent Claude session.

Reviews use your local Claude account and count toward its usage limits. Review
commands can read code, but cannot edit files or run tests. Rescue tasks can
edit repository text files when explicitly authorized with `--write`.

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

If Claude is missing, `$claude:setup --install` downloads a pinned native Claude
binary (2.1.236), verifies its size and SHA-256 checksum against the bundled
[release manifest][installer-manifest], then runs its install command. It does
not download or execute a shell script. It does not reinstall an existing CLI or
log you in. If the installed executable is not on PATH, add `~/.local/bin` and
restart your terminal before checking setup again.

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

Reviews, rescue, and transfer also accept `--effort low|medium|high|xhigh|max`.
Support depends on the selected Claude model. Omitting the option preserves
Claude's configured default.

## Delegate work and continue sessions

Use rescue to ask Claude to investigate a problem. Add `--write` for edits; the
calling agent runs any required tests after reviewing the changes:

```text
$claude:rescue --wait investigate why the cache is stale
$claude:rescue --background --write fix the cache bug and identify required tests
$claude:rescue --resume --write apply the follow-up fix
$claude:rescue --fresh investigate a different problem
$claude:rescue --resume-job JOB_ID continue that investigation
```

Read-only rescue uses the same repository inspection tool as reviews. Write mode
adds a repository-confined text editing tool; the task should state the
authorized scope. Shell commands and test execution are unavailable. Rescue
defaults to foreground. Model and effort are inherited from Claude unless
supplied explicitly. `--prompt-file PATH` accepts multiline task text without
shell interpolation and cannot be combined with positional task text.

Rescue and transfer save Claude sessions. `--resume` selects the latest
completed rescue in this Codex session and checkout. Transferred sessions are
excluded from rescue continuation, including explicit job selection.
`--resume-job JOB_ID` can select a specific finished job in the checkout,
including an older Codex session. If Claude omits a valid session ID, the
completed output is retained with a warning; continuation is unavailable. Each
continuation forks the saved conversation, so simultaneous follow-ups do not
write to the same Claude session. Write access is not inherited: include
`--write` only when the current task authorizes it. Results and individual-job
status include `claude --resume SESSION_ID` for interactive continuation from
that checkout.

Write jobs take a per-checkout lock and record Git status before and after
execution in a private `recovery.json` alongside the job. Before each file's
first edit, the tool saves its original UTF-8 content and mode in a private
`backups/` directory beside that record. Each JSON backup includes the relative
`path`, original `text`, and `mode`; `text: null` records a newly created file.
To recover, first stop the job and inspect the current changes, then restore
selected files from those records (or remove files whose original text was
null). Backups preserve dirty and untracked contents. Edits are not
automatically reverted, and backups follow the job retention policy below.

Cancellation and worker death terminate the supervised reviewer process group.
Write jobs are rejected on Windows, where this supervision is unavailable.
Interrupted jobs report possible partial edits; after a hard worker crash the
lock is retained until its processes and working tree have been inspected.
Release verifies lock ownership, and edits also require the owning token. This
lock coordinates plugin writers; external editors must not mutate paths or
manually replace locks while a writer is active.

## Hand off to Claude Code

```text
$claude:transfer
$claude:transfer --source /path/to/codex-session.jsonl
$claude:transfer --prompt-file /path/to/context.md
```

Transfer finds the current Codex transcript under `CODEX_HOME` (default
`~/.codex`) using the current session ID. You can supply an explicit transcript
or a UTF-8 context summary instead. It makes a paid Claude call with tools
disabled to acknowledge and persist the context, then prints a resume command.
It does not execute tasks from the transcript. `--background` is also supported.

This is a context handoff, not native conversation import. Only user/assistant
text is seeded into one Claude turn; tool output, reasoning, system messages,
images, and attachments are excluded. Input files over 8 MiB are rejected; use a
focused summary for larger sessions. The source remains unchanged.

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
for full details. ALLOW and SKIP both require a successful repository tool call;
no inspection (including an MCP startup failure) produces an INCOMPLETE notice.
Tool errors are reported to the reviewer and can be recovered by correcting or
retrying requests. The reviewer must report INCOMPLETE when required evidence
remains unavailable. BLOCK and INCOMPLETE explanations are preserved. Page
boundaries defer whole lines, and long lines return an offset and byteOffset
continuation without discarding their tails. The runtime checks a private
inspection record written by its MCP server. The verdict uses a validated JSON
schema; repository text remains untrusted evidence, and model review is not a
security boundary against prompt injection.

After an ALLOW, unchanged repository state in the same session can skip the
model call with a notice. The check hashes HEAD, index entries, and tracked and
untracked file contents before and after review. A failed or blocked attempt
invalidates the cached state. A new session, submodules, missing HEAD, or a
snapshot exceeding its 32 MiB/5-second file budget uses a fresh review.
Adversarial reviews never suppress the Stop gate: their verdicts and focused
review scopes do not establish an ALLOW for the previous Codex response.

## Privacy and storage

Claude inspects the checkout through one bundled stdio MCP tool with fixed
operations for file listing, paged reads, diffs, status, and history. It has no
built-in shell or file tools and cannot select arbitrary Git flags. File reads
exclude ignored files, common secret filenames, and symlinks that escape the
checkout. The same secret exclusions apply to diff content at every depth.
Listings, reads, and diffs stream into bounded pages; diffs accept a literal
file filter. Long lines include explicit continuation cursors. Review execution
disables other MCP servers, hooks, skills, and session persistence, and loads
user settings for credentials and model defaults. It doesn't load project or
local Claude settings. These are tool restrictions, not an operating-system
sandbox; source changes included in prompts may contain secrets.

Rescue write mode uses the same secret-filtered inspection tool and adds a
repository text editing tool. Built-in file and shell tools remain disabled;
user hooks remain enabled. Writes reject ignored files, sensitive paths,
symlinks, and paths outside the checkout, and require the exact expected current
content before replacement. Parent directories must already exist. These checks
are not an OS sandbox against concurrent external filesystem changes. Run tests
through the calling agent or an interactive session after inspecting edits.
Rescue and transfer sessions persist in Claude's own session storage; plugin
records retain results and session IDs. Plugin retention does not remove those
Claude transcripts. Transferred context can contain source code and other
conversation text.

Review data is stored outside your checkout with private file permissions:

```text
~/.codex/plugins/data/claude-review/jobs/
```

This includes prompts, findings, progress, and gate state, grouped by checkout.
The data may contain source code. Before creating each job, the runtime prunes
finished jobs older than 30 days and keeps at most 100 finished jobs per
checkout. Active jobs are preserved. Gate prompts are passed in memory and never
saved to the job store. Rescue and transfer prompts also stay out of job
records. Background launch saves a private 0600 prompt file and waits for the
worker to read, validate, delete, and acknowledge it. Delivery failures are
reported as failed jobs; a launcher crash before delivery can leave the private
file until job cleanup. Context inputs must resolve inside the checkout, the
system temporary directory, or `CODEX_HOME`; common credential paths and direct
symlinks are rejected. Content is not automatically redacted. Review what you
send; output and Claude transcripts may quote it. Completed jobs retain
findings, elapsed time and provider usage/cost when supplied. Manual review
prompts remain until their jobs are pruned. Set `CLAUDE_REVIEW_DATA_DIR` to use
another location.

<details>
<summary>Runtime details</summary>

- Automatic reviews have a two-minute subprocess timeout, leaving room within
  the Stop hook deadline for startup, cleanup, and verdict persistence. Explicit
  reviews and tasks run until completion or cancellation.
- Adversarial and automatic reviews use Claude's `--json-schema` option. The
  runtime validates the `structured_output` result and renders it as Markdown.
  Missing output and schema failures remain failed reviews.
- Progress comes from streamed tool and text events. A separate heartbeat tracks
  worker liveness; a stale heartbeat marks a job as interrupted.
- Cancellation stops the worker's own Claude process. The plugin doesn't set
  `--max-turns`. Only rescue and transfer create resumable Claude sessions.

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
[installer-manifest]:
  https://downloads.claude.ai/claude-code-releases/2.1.236/manifest.json

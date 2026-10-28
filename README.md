# agses

[![CI](https://github.com/reemus-dev/agses/actions/workflows/ci.yml/badge.svg)](https://github.com/reemus-dev/agses/actions/workflows/ci.yml)

Find, outline, read, search and rename Claude Code sessions from your terminal.

- List projects and sessions, newest activity first
- Outline a session as numbered events, then read any event in full
- Read across every compaction, not just the context since the last one
- Follow subagent threads and workflow runs from the parent session
- Search message text across one project or all of them
- Rename a session, as `/rename` does, even while it runs
- Get JSON output from every command that lists or reads sessions

`agses` reads the full transcripts that Claude Code already saves, exactly as
recorded, with no index to build or keep current. It is made for agents that
need to recover earlier work. It is not a memory system or an index.

## Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Session selection](#session-selection)
  - [Subagents and workflow runs](#subagents-and-workflow-runs)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Development](#development)
- [License](#license)

## Installation

<!-- prettier-ignore -->
> [!NOTE]
> `agses` requires [Bun](https://bun.sh/) 1.3.7 or later.

```sh
bun add -g agses-cli
```

Or run it without installing:

```sh
bunx agses-cli sessions
```

Shell completion is available for bash, zsh, fish and PowerShell:

```sh
source <(agses complete bash)
```

## Usage

```sh
agses projects
agses sessions [--project PATH_OR_QUERY | --all] [--limit N] [--size]
agses outline [SESSION] [--subagent ID] [--first N | --last N] [--no-tools] [--extra]
agses read [SESSION] [--subagent ID] [--role user|assistant|both] [--no-tools] [--extra] [--first N | --last N] [--entry N] [--tokens N]
agses search QUERY [--project PATH_OR_QUERY | --all] [--role user|assistant|both] [--subagents] [--context N] [--regex] [--case-sensitive]
agses workflows [SESSION] [--run ID|REF]
agses rename SESSION NAME
agses tokens [FILE] [--model opus|sonnet|haiku|ID]
```

A typical recovery starts with an outline, then reads the events that matter:

```sh
agses sessions --all --limit 20                # find the session
agses outline SESSION --last 40                # numbered events, newest last
agses read SESSION --entry 20                  # one event in full
agses read SESSION --no-tools --tokens 80000   # recent conversation within a token budget
agses search "query" --all --context 1         # matches with one message either side
```

- `agses` alone runs `agses sessions`.
- Every command that lists or reads sessions accepts `--format text|json`.
- `#N` refs in an outline number every event, including the attachment, meta and
  system entries that only `--extra` shows. A ref is the same with or without
  `--extra`. Pass it to `read --entry N`.
- `tokens` counts the tokens in a file, or stdin, for a model.
- Run `agses help` or `agses --help` for the guide, and `agses help <command>`
  for every option. `agses --version` prints the installed version.

### Session selection

Projects are the working directories that sessions recorded. `--project` takes
an exact path or a unique substring. Without it, `agses` uses the closest
project that contains the current directory.

`SESSION` resolves within that project, in this order:

1. A `.jsonl` path selects that session by file name. It must belong to
   `--project` when given.
2. Exactly 14 hex characters are a Hex ID, as `sessions` shows it, with no
   fallback to the other forms.
3. An exact session UUID.
4. An exact name, case-insensitive.
5. An unambiguous UUID prefix.

A session continued in a new transcript is not listed. It belongs to the project
of the session that continues it, where its path, Hex ID, UUID or UUID prefix
still selects it.

Without `--project`, a `SESSION` with no match in the current directory's
project, or given outside any project, resolves across all projects by the same
rules. An ambiguous match across projects fails and lists each candidate's
project. Pick one with `--project` or its Hex ID.

Omit `SESSION` to use the most recently active session of the project.

### Subagents and workflow runs

Outline rows that spawn, message or report back from a subagent show
`@SUBAGENT_ID`. Workflow calls and their task notifications show `@wf_RUN_ID`.

```sh
agses outline SESSION --subagent SUBAGENT_ID
agses read SESSION --subagent SUBAGENT_ID --entry 12
agses search "query" --subagents
agses workflows SESSION
agses workflows SESSION --run RUN_ID
```

- `--subagent` takes the id, a unique prefix (`@` optional), or the ref of a row
  that shows it (`131`). The subagent's thread has its own `#N` refs.
- `--run` takes a run id, a unique prefix (`wf_` optional), or the ref of a
  linked row (`40`), and shows the run's agents by phase.
- An all-digit value is always a ref.

## How it works

`agses` reads `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when
`CLAUDE_CONFIG_DIR` is not set. It never starts a model session.

A session's name, first prompt and working directory come from the first and
last 64 KB of its transcript. The name is the latest rename, else Claude Code's
AI title, then the last or first prompt. For events, `agses` reads the whole
transcript and follows its `parentUuid` chain back from the latest branch, so
abandoned branches stay out. It re-parents each compaction boundary onto the
history before it, so the thread runs through every compaction instead of
stopping at the last one.

Resuming a compacted session can continue it in a new transcript. The new
transcript repeats the compaction, and the old one ends with a `continued-in`
entry that names the new session. `agses` reads the old history first, so the
new session's thread, subagents and workflow runs still span every compaction.

- **Projects** are the directories sessions started in, as Claude Code files
  them. A session started in a git worktree belongs to the worktree path.
- **Events** are user and assistant text, compaction summaries, and tool calls
  on the main thread, plus extras: attachments (hook output, file and reminder
  context), plugin and meta messages, system entries, and harness noise
  (interruptions, slash-command output, reminder-only turns). Extras are hidden
  unless `--extra` is given. Thinking is dropped. Tool results attach to their
  call.
- **Subagents** each keep one transcript,
  `<session>/subagents/agent-<id>.jsonl`, across every continuation. Its
  `.meta.json` names the Agent call that spawned it. On the parent thread, that
  call, `SendMessage` calls to the subagent, and its hand-backs and task
  notifications show `@<id>`. A fork's thread starts at its spawning call,
  skipping the parent history its transcript copies. Workflow agents are
  subagents under `<session>/subagents/workflows/<runId>/`. Their `.meta.json`
  names the workflow phase instead of a spawning call.
- **Workflow runs** start from a Workflow call. Its result names the run and the
  launch's task, and the call and the launch's task notification show
  `@<runId>`. A resume reuses the run under a new task. The run's journal
  (`journal.jsonl` beside its agents) records each agent's start and outcome as
  it runs. The snapshot `<session>/workflows/<runId>.json` adds status, usage
  and errors when a launch settles. It only counts while it records the latest
  launch. Until then, the latest launch's notification gives the status, or it
  is `unknown`.

## Privacy

- Only `rename` writes to the Claude Code config directory. It appends one
  `custom-title` entry to the session's transcript, as `/rename` and the Agent
  SDK's `renameSession` do. A running session shows the new name the next time
  it records its name, or when resumed.
- Everything runs locally, except `tokens`. It sends its input to Anthropic's
  token-counting API and needs `AGSES_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`,
  in that order. Claude Code can use `ANTHROPIC_API_KEY` in place of your
  subscription login, so export `AGSES_ANTHROPIC_API_KEY` to make the key
  available in every shell.

## Development

Requires [Mise](https://mise.jdx.dev/).

```sh
mise install
mise run check
```

Run from source with `bun src/index.ts <command>`.

## License

[MIT](LICENSE)

# agses

`agses` is a Bun CLI that finds, outlines, reads and searches persisted Claude
Code sessions. It publishes its TypeScript source to npm and runs it with Bun
1.3.7 or later.

Read `README.md` for the user contract.

## Where to work

| Area                         | Responsibility                                              |
| ---------------------------- | ----------------------------------------------------------- |
| `src/index.ts`               | Entry, command tree, usage guide and shell completion       |
| `src/commands/`              | One citty command per file, parsing and output              |
| `src/modules/discovery.ts`   | Listing sessions and grouping them into projects            |
| `src/modules/sessions.ts`    | Session and subagent resolution, transcript I/O             |
| `src/modules/transcripts.ts` | Session metadata and thread selection from transcripts      |
| `src/modules/events.ts`      | Projecting a thread's entries into numbered events          |
| `src/modules/previews.ts`    | One-line previews of tool calls                             |
| `src/modules/workflows.ts`   | Workflow runs from Workflow calls, journals and snapshots   |
| `src/modules/format.ts`      | Text tables, paths, sizes, dates and durations              |
| `src/modules/cli.ts`         | Failures, strict argument validation and `--first`/`--last` |

## Design constraints

- Only `rename` writes to the Claude Code config directory. It appends one
  `custom-title` entry, as the Agent SDK's `renameSession` does. Everything else
  reads.
- Resolve the config directory from `CLAUDE_CONFIG_DIR`, as Claude Code does,
  and fall back to `~/.claude`.
- `src/modules/transcripts.ts` derives from the MIT-licensed Claude Agent SDK
  for Python, adjusted to match what the TypeScript SDK returns. Keep its
  license notice.
- A thread spans every compaction. A session continued in a new transcript reads
  the old transcript first.
- `#N` refs number every event, extras included, so a ref holds with or without
  `--extra`.
- Only `tokens` uses the network. It requires `AGSES_ANTHROPIC_API_KEY` or, as a
  fallback, `ANTHROPIC_API_KEY`.

## Development

Install the locked toolchain with `mise install`. `.mise.toml` is the authority
for commands and tool versions. Run the complete gate with:

```sh
mise run check
```

Run from source with `bun src/index.ts <command>`.

`test/cli.test.ts` runs the CLI against the Claude Code transcripts in
`test/fixtures`. Point `CLAUDE_CONFIG_DIR` at that directory to try a command on
them. `test/fixtures.ts` writes them. Change it rather than the transcripts, and
run `bun test/fixtures.ts`.

Release with `mise run release patch NOTES` (or `minor`, `major`, an exact
version), where `NOTES` is a Markdown file of release notes. It sets the version
in `package.json`, commits, tags with the notes as the message and pushes. The
tag starts `release.yml`, which publishes to npm and to a GitHub release that
shows the notes. Do not edit the version or tag by hand.

Write the notes for people who use `agses`, from the changes since the last
release. Open with one sentence on what the release brings. Then list changes
under `## Breaking changes`, `## Features` and `## Fixes`, leaving out empty
sections, and end with `## Install`. Follow an earlier release, such as
`gh release view v0.3.0`.

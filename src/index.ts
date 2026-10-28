#!/usr/bin/env bun
// Must run before citty loads and reads the color setting
// oxlint-disable-next-line import/no-unassigned-import
import "./modules/plain-output.js";
import {
  type ArgsDef,
  type CommandDef,
  defineCommand,
  renderUsage,
  runMain,
} from "citty";
import tab from "@bomb.sh/tab/citty";
import packageJson from "../package.json" with {type: "json"};
import {outlineCommand} from "./commands/outline.js";
import {projectsCommand} from "./commands/projects.js";
import {readCommand} from "./commands/read.js";
import {renameCommand} from "./commands/rename.js";
import {searchCommand} from "./commands/search.js";
import {sessionsCommand} from "./commands/sessions.js";
import {tokensCommand} from "./commands/tokens.js";
import {workflowsCommand} from "./commands/workflows.js";

const USAGE_GUIDE = `---

# PRACTICAL GUIDE

## Find sessions

\`\`\`sh
agses projects
agses sessions --project /path/to/project
agses sessions --all --limit 20
agses search "query" --project /path/to/project
agses search "query" --all --context 1
\`\`\`

## Rename a session

\`\`\`sh
agses rename SESSION "New name"
\`\`\`

## Inspect a session

\`\`\`sh
agses outline SESSION --last 40
agses read SESSION --entry 20
agses read SESSION --no-tools --tokens 80000
agses outline SESSION --subagent SUBAGENT_ID
agses read SESSION --subagent SUBAGENT_ID --entry 12
agses workflows SESSION
agses workflows SESSION --run RUN_ID
\`\`\`

## Selection rules

- \`SESSION\` accepts a .jsonl path, UUID or prefix, 14-character Hex ID, or exact name.
- Projects are recorded session working directories. \`--project\` takes an exact path or unique substring; otherwise the closest project containing the current directory is used.
- Without \`--project\`, \`SESSION\` falls back to all projects when the current directory has no project or no match. An ambiguous match across projects lists each candidate with its project; pick one with \`--project\` or its Hex ID.
- Omit \`SESSION\` to use the most recently active session in the resolved project.
- \`agses\` alone runs \`agses sessions\`. \`sessions --all\` lists every project's sessions, newest activity first. \`--limit N\` caps the listing, and \`--size\` adds each transcript's size.
- \`read\`, \`outline\` and \`search\` cover the session's main thread, including history before each compaction.
- Outline rows that spawn, message, or report back from a subagent show \`@SUBAGENT_ID\`. Pass it, a unique prefix, or the row's ref (\`131\`) to \`--subagent\` on \`outline\` and \`read\` to use that subagent's thread, numbered with its own refs. \`search --subagents\` also searches subagent threads. Workflow agents are subagents too.
- Workflow calls and their task notifications show \`@wf_RUN_ID\`. \`workflows\` lists the session's runs. \`--run\` takes a run ID, a unique prefix (\`wf_\` optional), or a linked row's ref (\`40\`), and shows the run's agents by phase. An all-digit value is always a ref.
- Outline \`#N\` references number every event, including the attachment, meta, and system entries that only \`--extra\` shows. Inspect one in full with \`read --entry N\`.
- Add \`--format json\` for structured output.

> Run \`agses <command> --help\` for every option.`;

// `agses` alone lists sessions, and `agses help [command]` shows help
let rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) rawArgs = ["sessions"];
else if (rawArgs[0] === "help") rawArgs = [...rawArgs.slice(1), "--help"];

async function showUsage<T extends ArgsDef = ArgsDef>(
  shownCommand: CommandDef<T>,
  parent?: CommandDef<T>,
): Promise<void> {
  const includeGuide =
    parent === undefined &&
    rawArgs.some((argument) => argument === "--help" || argument === "-h");
  const usage = await renderUsage(shownCommand, parent);
  process.stdout.write(`${usage}${includeGuide ? `\n\n${USAGE_GUIDE}` : ""}\n`);
}

const app = defineCommand({
  meta: {
    name: "agses",
    version: packageJson.version,
    description: "Discover, inspect, search, and rename Claude Code sessions.",
  },
  subCommands: {
    projects: projectsCommand,
    sessions: sessionsCommand,
    read: readCommand,
    outline: outlineCommand,
    search: searchCommand,
    tokens: tokensCommand,
    workflows: workflowsCommand,
    rename: renameCommand,
  },
});

// Register shell completions — introspects full command tree, injects `complete` subcommand
await tab(app);

await runMain(app, {rawArgs, showUsage});

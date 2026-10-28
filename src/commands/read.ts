import {defineCommand} from "citty";
import {
  CliFailure,
  parsePositiveInteger,
  runSafely,
  selectWindow,
  validateArguments,
} from "../modules/cli.js";
import type {SessionEvent} from "../modules/events.js";
import {
  formatEvent,
  formatEventDetail,
  formatFrontmatter,
  printJson,
} from "../modules/format.js";
import {
  readThread,
  resolveSession,
  sessionFrontmatter,
} from "../modules/sessions.js";

function matchesFilters(
  event: SessionEvent,
  role: "assistant" | "both" | "user",
  tools: boolean,
  extra: boolean,
): boolean {
  switch (event.kind) {
    case "message": {
      return role === "both" || event.role === role;
    }
    case "compaction": {
      return role !== "assistant";
    }
    case "extra": {
      return extra;
    }
    case "tool": {
      return tools && role !== "user";
    }
  }
}

/**
 * Keep the most recent events whose rendered text fits the budget (~4 chars per
 * token)
 */
function truncateToTokenBudget(
  events: SessionEvent[],
  budget: number,
): SessionEvent[] {
  let tokens = 0;
  let start = events.length;
  while (start > 0) {
    const next = Math.ceil(formatEvent(events[start - 1]!).length / 4);
    if (tokens + next > budget) break;
    tokens += next;
    start--;
  }
  return events.slice(start);
}

export const readCommand = defineCommand({
  meta: {
    name: "read",
    description:
      "Read messages and tool calls on a session's main thread or a subagent's thread.",
  },
  args: {
    session: {
      type: "positional",
      description: "Session path, UUID/prefix, 14-char Hex ID, or exact name",
      required: false,
    },
    project: {
      type: "string",
      description: "Project path or unique cwd substring",
      alias: ["p"],
    },
    subagent: {
      type: "string",
      description:
        "Read this subagent's thread instead (id, prefix, or linked entry ref)",
      alias: ["s"],
      valueHint: "id|ref",
    },
    role: {
      type: "enum",
      description: "Message role",
      alias: ["r"],
      options: ["user", "assistant", "both"] as const,
      default: "both",
    },
    tools: {
      type: "boolean",
      description: "Include compact tool calls",
      default: true,
    },
    extra: {
      type: "boolean",
      description: "Include attachment, meta, and system entries",
      alias: ["x"],
      default: false,
    },
    first: {
      type: "string",
      description: "Show the first matching events",
      valueHint: "count",
    },
    last: {
      type: "string",
      description: "Show the last matching events",
      valueHint: "count",
    },
    entry: {
      type: "string",
      description: "Read one outline entry in full",
      valueHint: "position",
    },
    tokens: {
      type: "string",
      description:
        "Keep only the most recent events within an estimated token budget",
      alias: ["t"],
      valueHint: "count",
    },
    format: {
      type: "enum",
      description: "Output format",
      alias: ["f"],
      options: ["text", "json"] as const,
      default: "text",
    },
  },
  async run({args, rawArgs, cmd}) {
    await runSafely(async () => {
      await validateArguments(rawArgs, cmd.args);
      const budget =
        args.tokens === undefined
          ? undefined
          : parsePositiveInteger(args.tokens, "--tokens");
      const session = await resolveSession(args.session, args.project);
      const {subagent, events} = await readThread(session, args.subagent);

      if (args.entry !== undefined) {
        const reference = parsePositiveInteger(args.entry, "--entry");
        const event = events.find(({ref}) => ref === reference);
        if (!event)
          throw new CliFailure(`Session entry #${reference} does not exist.`);

        if (args.format === "json") {
          printJson({session, subagent, event});
          return;
        }
        process.stdout.write(`${formatEventDetail(event)}\n`);
        return;
      }

      const {selected: windowed} = selectWindow(
        events.filter((event) =>
          matchesFilters(event, args.role, args.tools, args.extra),
        ),
        args.first,
        args.last,
      );
      const selected =
        budget === undefined
          ? windowed
          : truncateToTokenBudget(windowed, budget);

      if (args.format === "json") {
        printJson({session, subagent, events: selected});
        return;
      }

      const frontmatter = formatFrontmatter(
        sessionFrontmatter(session, subagent),
      );
      process.stdout.write(
        `${[frontmatter, ...selected.map(formatEvent)].join("\n\n")}\n`,
      );
    });
  },
});

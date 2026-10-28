import {defineCommand} from "citty";
import {runSafely, selectWindow, validateArguments} from "../modules/cli.js";
import type {SessionEvent} from "../modules/events.js";
import {
  formatFrontmatter,
  formatPreview,
  outputWidth,
  printJson,
} from "../modules/format.js";
import {
  readThread,
  resolveSession,
  sessionFrontmatter,
} from "../modules/sessions.js";

const MAXIMUM_LABEL_WIDTH = 32;

function eventLabel(event: SessionEvent): string {
  switch (event.kind) {
    case "message": {
      return event.role;
    }
    case "compaction": {
      return "compaction";
    }
    case "extra":
    case "tool": {
      return event.name;
    }
  }
}

/** `mcp__server__tool` reads as `server:tool` in the label column */
function rowLabel(event: SessionEvent): string {
  return eventLabel(event).replace(/^mcp__(.+?)__/, "$1:");
}

function formatRow(
  event: SessionEvent,
  labelWidth: number,
  refWidth: number,
  width: number,
): string {
  const linked =
    event.kind === "tool" || event.kind === "message"
      ? (event.subagent ?? event.workflow?.runId)
      : undefined;
  const link = linked === undefined ? "" : `@${linked} `;
  const label = formatPreview(rowLabel(event), labelWidth).padEnd(labelWidth);
  const prefix = `${`#${event.ref}`.padEnd(refWidth)} ${label} ${link}`;
  const preview = event.kind === "tool" ? event.preview : event.text;
  const error =
    event.kind === "tool" && event.result?.error === true ? " [error]" : "";
  return `${prefix}${formatPreview(`${preview}${error}`, Math.max(1, width - prefix.length))}`.trimEnd();
}

export const outlineCommand = defineCommand({
  meta: {
    name: "outline",
    description:
      "Outline activity on a Claude Code session's main thread or a subagent's thread.",
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
        "Outline this subagent's thread instead (id, prefix, or linked entry ref)",
      alias: ["s"],
      valueHint: "id|ref",
    },
    first: {
      type: "string",
      description: "Show the first activity events",
      valueHint: "count",
    },
    last: {
      type: "string",
      description: "Show the last activity events",
      valueHint: "count",
    },
    tools: {
      type: "boolean",
      description: "Include tool calls",
      default: true,
    },
    extra: {
      type: "boolean",
      description: "Include attachment, meta, and system entries",
      alias: ["x"],
      default: false,
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
      const session = await resolveSession(args.session, args.project);
      const thread = await readThread(session, args.subagent);
      const events = thread.events.filter(
        (event) =>
          (args.extra || event.kind !== "extra") &&
          (args.tools || event.kind !== "tool"),
      );
      const {selected, omittedBefore, omittedAfter} = selectWindow(
        events,
        args.first,
        args.last,
      );

      if (args.format === "json") {
        printJson({
          session,
          subagent: thread.subagent,
          omittedBefore,
          omittedAfter,
          events: selected.map((event) => ({
            ref: event.ref,
            kind: event.kind,
            label: eventLabel(event),
            timestamp: event.timestamp,
            preview:
              event.kind === "tool"
                ? event.preview
                : formatPreview(event.text, 200),
            ...(event.kind === "tool"
              ? {error: event.result?.error === true}
              : {}),
            ...(event.kind === "tool" || event.kind === "message"
              ? {subagent: event.subagent, workflow: event.workflow}
              : {}),
          })),
        });
        return;
      }

      const width = outputWidth();
      const labelWidth = Math.min(
        MAXIMUM_LABEL_WIDTH,
        Math.max(1, ...selected.map((event) => rowLabel(event).length)),
      );
      const refWidth = `#${selected.at(-1)?.ref ?? 0}`.length;
      const lines = [
        ...(omittedBefore === 0
          ? []
          : [`… ${omittedBefore} earlier activity events omitted`]),
        ...selected.map((event) =>
          formatRow(event, labelWidth, refWidth, width),
        ),
        ...(omittedAfter === 0
          ? []
          : [`… ${omittedAfter} later activity events omitted`]),
      ];
      const frontmatter = formatFrontmatter(
        sessionFrontmatter(session, thread.subagent),
      );
      process.stdout.write(`${frontmatter}\n\n${lines.join("\n")}\n`);
    });
  },
});

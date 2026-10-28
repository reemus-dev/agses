import {defineCommand} from "citty";
import {
  CliFailure,
  parsePositiveInteger,
  runSafely,
  validateArguments,
} from "../modules/cli.js";
import {discoverProjects, sessionsOf} from "../modules/discovery.js";
import {
  formatDateTime,
  formatDuration,
  formatPreview,
  formatSize,
  formatTable,
  outputWidth,
  printJson,
} from "../modules/format.js";
import {resolveProject} from "../modules/sessions.js";

export const sessionsCommand = defineCommand({
  meta: {
    name: "sessions",
    description:
      "List sessions for a resolved Claude Code project or all projects.",
  },
  args: {
    project: {
      type: "string",
      description: "Project path or unique cwd substring",
      alias: ["p"],
    },
    all: {
      type: "boolean",
      description: "List sessions across all projects",
      alias: ["a"],
      default: false,
    },
    limit: {
      type: "string",
      description: "Show at most this many sessions",
      valueHint: "count",
    },
    size: {
      type: "boolean",
      description: "Show each transcript's size",
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
      if (args.all && args.project !== undefined) {
        throw new CliFailure("--project and --all are mutually exclusive.");
      }
      const limit =
        args.limit === undefined
          ? undefined
          : parsePositiveInteger(args.limit, "--limit");
      const projects = await discoverProjects();
      const sessions = sessionsOf(
        args.all ? projects : [resolveProject(projects, args.project)],
      ).slice(0, limit);

      if (args.format === "json") {
        printJson({sessions});
        return;
      }

      // Across projects, the project path takes the room of the creation
      // time and first prompt
      const width = outputWidth();
      const now = Date.now();
      const includeProject = args.all;
      const includeName = width >= 25;
      const includeIdle = width >= 35;
      const includeCreated = !args.all && width >= 70;
      const includeFirstPrompt = !args.all && width >= 90;
      const includeSize = args.size;
      const headers = [
        "Hex ID",
        ...(includeName ? ["Name"] : []),
        ...(includeProject ? ["Project"] : []),
        ...(includeCreated ? ["Created"] : []),
        ...(includeIdle ? ["Idle"] : []),
        ...(includeSize ? ["Size"] : []),
        ...(includeFirstPrompt ? ["First prompt"] : []),
      ];
      const rows = sessions.map((session) => [
        session.hexId,
        ...(includeName ? [formatPreview(session.name)] : []),
        ...(includeProject ? [session.project] : []),
        ...(includeCreated ? [formatDateTime(session.created)] : []),
        ...(includeIdle
          ? [
              formatDuration(
                Math.max(0, now - Date.parse(session.lastActivity)),
              ),
            ]
          : []),
        ...(includeSize ? [formatSize(session.size)] : []),
        ...(includeFirstPrompt
          ? [formatPreview(session.firstPrompt ?? "-")]
          : []),
      ]);
      // The name identifies a session, so it gives up room last
      const flexibleColumns = ["First prompt", "Project", "Name"]
        .map((header) => headers.indexOf(header))
        .filter((index) => index !== -1);
      process.stdout.write(
        `${formatTable(headers, rows, {flexibleColumns, maximumWidth: width})}\n`,
      );
    });
  },
});

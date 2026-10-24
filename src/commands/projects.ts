import {defineCommand} from "citty";
import {runSafely, validateArguments} from "../modules/cli.js";
import {discoverProjects} from "../modules/discovery.js";
import {
  formatDate,
  formatDateTime,
  formatSize,
  formatTable,
  outputWidth,
  printJson,
} from "../modules/format.js";

export const projectsCommand = defineCommand({
  meta: {
    name: "projects",
    description: "List projects found in Claude Code session metadata.",
  },
  args: {
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
      const output = (await discoverProjects())
        .map(({project, sessions}) => ({
          project,
          sessions: sessions.length,
          size: sessions.reduce((sum, session) => sum + session.size, 0),
          firstSession:
            sessions
              .map((session) => session.created)
              .filter((created) => created !== null)
              .toSorted()[0] ?? null,
          lastActivity: sessions[0]!.lastActivity,
        }))
        .toSorted((left, right) =>
          right.lastActivity.localeCompare(left.lastActivity),
        );

      if (args.format === "json") {
        printJson({projects: output});
        return;
      }

      const width = outputWidth();
      const includeFirstSession = width >= 60;
      const headers = [
        "Project",
        "Sessions",
        "Size",
        ...(includeFirstSession ? ["First session"] : []),
        "Last activity",
      ];
      const rows = output.map((project) => [
        project.project,
        String(project.sessions),
        formatSize(project.size),
        ...(includeFirstSession ? [formatDate(project.firstSession)] : []),
        formatDateTime(project.lastActivity),
      ]);
      process.stdout.write(
        `${formatTable(headers, rows, {flexibleColumns: [0], maximumWidth: width})}\n`,
      );
    });
  },
});

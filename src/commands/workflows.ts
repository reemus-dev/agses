import {defineCommand} from "citty";
import {runSafely, validateArguments} from "../modules/cli.js";
import type {SessionRecord} from "../modules/discovery.js";
import {
  formatDuration,
  formatFrontmatter,
  formatPreview,
  formatTable,
  outputWidth,
  printJson,
  shortenPath,
} from "../modules/format.js";
import {
  readSessionEvents,
  readSubagents,
  resolveSession,
  sessionFrontmatter,
} from "../modules/sessions.js";
import {
  readWorkflowRuns,
  resolveWorkflowRun,
  type WorkflowRun,
} from "../modules/workflows.js";

function formatTokens(tokens: number | null): string {
  if (tokens === null) return "-";
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function launchRefs(run: WorkflowRun): string {
  return run.launches.map(({ref}) => `#${ref}`).join(", ") || "-";
}

function agentCount(phases: WorkflowRun["phases"]): number {
  return phases.reduce((total, {agents}) => total + agents.length, 0);
}

function formatRuns(session: SessionRecord, runs: WorkflowRun[]): string {
  const frontmatter = formatFrontmatter(sessionFrontmatter(session, null));
  if (runs.length === 0) {
    return `${frontmatter}\n\nNo workflow runs in this session.`;
  }
  const headers = [
    "Launch",
    "Run",
    "Name",
    "Status",
    "Agents",
    "Tokens",
    "Duration",
  ];
  const rows = runs.map((run) => [
    launchRefs(run),
    run.runId,
    run.name ?? "-",
    run.status,
    String(agentCount(run.phases)),
    formatTokens(run.tokens),
    formatDuration(run.duration),
  ]);
  return `${frontmatter}\n\n${formatTable(headers, rows, {flexibleColumns: [2], maximumWidth: outputWidth()})}`;
}

function formatRun(session: SessionRecord, run: WorkflowRun): string {
  // Key run fields lead, and long values trail so short ones stay scannable
  const frontmatter = formatFrontmatter({
    run: run.runId,
    name: run.name,
    status: run.status,
    error: run.error?.split("\n")[0] ?? null,
    launches: run.launches.length === 0 ? null : launchRefs(run),
    tokens: run.tokens === null ? null : formatTokens(run.tokens),
    duration: run.duration === null ? null : formatDuration(run.duration),
    hexId: session.hexId,
    sessionName: session.name,
    project: session.project,
    summary: run.summary,
    script: run.scriptPath === null ? null : shortenPath(run.scriptPath),
    snapshot: run.snapshot === null ? null : shortenPath(run.snapshot),
  });
  const headers = [
    "Phase",
    "Agent",
    "Label",
    "Model",
    "State",
    "Tokens",
    "Tools",
    "Duration",
    "Result",
  ];
  const rows = run.phases.flatMap(({title, agents}) => {
    const phase = title ?? "-";
    if (agents.length === 0) return [[phase, "-"]];
    return agents.map((agent, index) => [
      index === 0 ? phase : "",
      `@${agent.id}`,
      agent.label ?? "-",
      agent.model ?? "-",
      agent.state,
      formatTokens(agent.tokens),
      agent.toolCalls === null ? "-" : String(agent.toolCalls),
      formatDuration(agent.duration),
      formatPreview(agent.result ?? "-", 200),
    ]);
  });
  const table =
    rows.length === 0
      ? "No agents recorded."
      : formatTable(headers, rows, {
          flexibleColumns: [8, 2],
          maximumWidth: outputWidth(),
        });
  return `${frontmatter}\n\n${table}`;
}

export const workflowsCommand = defineCommand({
  meta: {
    name: "workflows",
    description:
      "List a Claude Code session's workflow runs, or show one run's agents by phase.",
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
    run: {
      type: "string",
      description:
        "Show this run's agents (run id, prefix, or linked entry ref)",
      alias: ["r"],
      valueHint: "id|ref",
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
      const subagents = await readSubagents(session);
      const events = await readSessionEvents(session, subagents);
      const runs = await readWorkflowRuns(session, subagents, events);

      if (args.run !== undefined) {
        const run = resolveWorkflowRun(runs, events, args.run);
        if (args.format === "json") {
          printJson({session, run});
          return;
        }
        process.stdout.write(`${formatRun(session, run)}\n`);
        return;
      }

      if (args.format === "json") {
        printJson({
          session,
          runs: runs.map(({phases, result, ...run}) => ({
            ...run,
            agents: agentCount(phases),
          })),
        });
        return;
      }
      process.stdout.write(`${formatRuns(session, runs)}\n`);
    });
  },
});

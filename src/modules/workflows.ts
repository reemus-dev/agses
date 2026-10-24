import {existsSync} from "node:fs";
import path from "node:path";
import {CliFailure} from "./cli.js";
import type {SessionRecord} from "./discovery.js";
import type {SessionEvent, WorkflowLaunch} from "./events.js";
import {sessionTranscripts, type SubagentRecord} from "./sessions.js";

/** Run statuses after which no agent of the run is still working */
const SETTLED_STATUSES = new Set(["completed", "failed", "killed"]);
const FINISHED_AGENT_STATES = new Set(["cached", "done", "error"]);
const NOTICE_STATUS = /<status>([^<]+)<\/status>/;

export type RunLaunch = {
  /** Main-thread ref of the Workflow call */
  ref: number;
  taskId: string;
  /** The launch's task notification, once it arrived */
  notice: {ref: number; status: string | null} | null;
};

export type WorkflowAgent = {
  id: string;
  label: string | null;
  phase: string | null;
  model: string | null;
  /**
   * The recorded state (`started`, `done`, `error`, …), `cached` for a result a
   * resume reused, or `stopped` when the run settled first
   */
  state: string;
  tokens: number | null;
  toolCalls: number | null;
  duration: number | null;
  result: string | null;
};

export type WorkflowRun = {
  runId: string;
  name: string | null;
  summary: string | null;
  /**
   * From the run's snapshot when it records the latest launch, else from that
   * launch's task notification, else `unknown`
   */
  status: string;
  launches: RunLaunch[];
  scriptPath: string | null;
  /** Snapshot file, rewritten each time a launch settles */
  snapshot: string | null;
  error: string | null;
  /** The script's return value; this and the totals cover the latest launch */
  result: unknown;
  tokens: number | null;
  toolCalls: number | null;
  duration: number | null;
  phases: Array<{title: string | null; agents: WorkflowAgent[]}>;
};

// ── Discovery ─────────────────────────────────────────────────────────

/**
 * The session's workflow runs in launch order. A run keeps a snapshot,
 * `workflows/<runId>.json`, written when a launch settles, and a journal and
 * agent transcripts under `subagents/workflows/<runId>/`, written as it runs. A
 * resume reuses the run under a new launch, so a snapshot may describe an
 * earlier launch than the latest. A run's files sit under the session that
 * launched it, which may be one this session continues.
 */
export async function readWorkflowRuns(
  session: SessionRecord,
  subagents: SubagentRecord[],
  events: SessionEvent[],
): Promise<WorkflowRun[]> {
  const directory = path.join(path.dirname(session.transcript), session.id);

  const launchesByRun = new Map<string, RunLaunch[]>();
  const reportedByRun = new Map<string, WorkflowLaunch>();
  const launchesByTaskId = new Map<string, RunLaunch>();
  for (const event of events) {
    if (event.kind === "tool" && event.workflow) {
      const {runId, taskId} = event.workflow;
      const launch: RunLaunch = {ref: event.ref, taskId, notice: null};
      launchesByRun.set(runId, [...(launchesByRun.get(runId) ?? []), launch]);
      reportedByRun.set(runId, event.workflow);
      launchesByTaskId.set(taskId, launch);
    } else if (event.kind === "message" && event.workflow) {
      const launch = launchesByTaskId.get(event.workflow.taskId);
      if (launch) {
        const status = NOTICE_STATUS.exec(event.text)?.[1] ?? null;
        launch.notice = {ref: event.ref, status};
      }
    }
  }

  const runDirectories = new Map<string, string>();
  // Newest first, so a run whose files several sessions hold reads the latest
  for (const owner of sessionTranscripts(session).toReversed()) {
    const ownerDirectory = path.join(path.dirname(owner.transcript), owner.id);
    if (!existsSync(ownerDirectory)) continue;
    const glob = (pattern: string) =>
      new Bun.Glob(pattern).scan(ownerDirectory);
    const found = (runId: string) => {
      if (!runDirectories.has(runId)) runDirectories.set(runId, ownerDirectory);
    };
    for await (const match of glob("workflows/wf_*.json")) {
      found(path.basename(match, ".json"));
    }
    for await (const match of glob("subagents/workflows/*/journal.jsonl")) {
      found(path.basename(path.dirname(match)));
    }
  }
  const runIds = new Set([...launchesByRun.keys(), ...runDirectories.keys()]);

  const runs = await Promise.all(
    [...runIds].map((runId) =>
      readRun(
        runDirectories.get(runId) ?? directory,
        runId,
        launchesByRun.get(runId) ?? [],
        reportedByRun.get(runId),
        subagents.filter((subagent) => subagent.runId === runId),
      ),
    ),
  );
  const firstRef = (run: WorkflowRun) =>
    run.launches[0]?.ref ?? Number.POSITIVE_INFINITY;
  return runs.toSorted(
    (left, right) =>
      firstRef(left) - firstRef(right) || left.runId.localeCompare(right.runId),
  );
}

async function readRun(
  directory: string,
  runId: string,
  launches: RunLaunch[],
  reported: WorkflowLaunch | undefined,
  subagents: SubagentRecord[],
): Promise<WorkflowRun> {
  const snapshotFile = path.join(directory, "workflows", `${runId}.json`);
  const snapshot = existsSync(snapshotFile)
    ? record(await Bun.file(snapshotFile).json())
    : null;
  const journalFile = Bun.file(
    path.join(directory, "subagents", "workflows", runId, "journal.jsonl"),
  );
  const journal = (await journalFile.exists())
    ? Bun.JSONL.parse(await journalFile.bytes()).map(record)
    : [];

  const latest = launches.at(-1);
  const current =
    snapshot !== null &&
    (latest === undefined || snapshot.taskId === latest.taskId)
      ? snapshot
      : null;
  const status = text(current?.status) ?? latest?.notice?.status ?? "unknown";
  // The Workflow result names the run. The snapshot fills in what it omits.
  const described = (
    field: "name" | "summary" | "scriptPath",
    key: string,
  ): string | null => reported?.[field] ?? text(snapshot?.[key]);

  return {
    runId,
    name: described("name", "workflowName"),
    summary: described("summary", "summary"),
    status,
    launches,
    scriptPath: described("scriptPath", "scriptPath"),
    snapshot: snapshot === null ? null : snapshotFile,
    ...settledUsage(current),
    phases: groupAgents(
      readAgents(
        journal,
        subagents,
        records(current?.workflowProgress).filter(
          ({type}) => type === "workflow_agent",
        ),
        SETTLED_STATUSES.has(status),
      ),
      records(current?.phases).map((phase) => text(phase.title)),
    ),
  };
}

/** What the current snapshot records about the latest launch's outcome */
function settledUsage(current: Record<string, unknown> | null) {
  return {
    error: text(current?.error),
    result: current?.result ?? null,
    tokens: count(current?.totalTokens),
    toolCalls: count(current?.totalToolCalls),
    duration: count(current?.durationMs),
  };
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

/**
 * Agents across every launch of the run, in the current snapshot's script
 * order, then in start order. The journal records each start and outcome as it
 * happens. The current snapshot adds the latest launch's usage, and marks
 * results a resume reused.
 */
function readAgents(
  journal: Array<Record<string, unknown>>,
  subagents: SubagentRecord[],
  progress: Array<Record<string, unknown>>,
  settled: boolean,
): WorkflowAgent[] {
  const agents = new Map<string, WorkflowAgent>();
  const agentFor = (id: string) => {
    const known = agents.get(id);
    if (known) return known;
    const agent: WorkflowAgent = {
      id,
      label: null,
      phase: null,
      model: null,
      state: "started",
      tokens: null,
      toolCalls: null,
      duration: null,
      result: null,
    };
    agents.set(id, agent);
    return agent;
  };

  for (const entry of journal) {
    const id = text(entry.agentId);
    if (!id) continue;
    const agent = agentFor(id);
    switch (entry.type) {
      case "started": {
        agent.label = text(entry.label);
        agent.phase = text(entry.phase);
        agent.state = "started";
        break;
      }
      case "result": {
        agent.state = "done";
        agent.result = text(entry.result);
        break;
      }
      case "failed": {
        agent.state = "error";
        break;
      }
    }
  }
  for (const subagent of subagents) {
    const agent = agentFor(subagent.id);
    agent.label ??= subagent.description;
    agent.phase ??= subagent.phase;
  }
  for (const entry of progress) {
    const id = text(entry.agentId);
    if (!id) continue;
    const agent = agentFor(id);
    agent.label = text(entry.label) ?? agent.label;
    agent.phase = text(entry.phaseTitle) ?? agent.phase;
    agent.model = text(entry.model);
    agent.state =
      entry.cached === true ? "cached" : (text(entry.state) ?? agent.state);
    agent.tokens = count(entry.tokens);
    agent.toolCalls = count(entry.toolCalls);
    agent.duration = count(entry.durationMs);
    agent.result ??= text(entry.resultPreview);
  }

  // A killed run leaves its unfinished agents in their last progress state
  if (settled) {
    for (const agent of agents.values()) {
      if (!FINISHED_AGENT_STATES.has(agent.state)) agent.state = "stopped";
    }
  }
  const positions = new Map(
    progress.map((entry, index) => [text(entry.agentId), index]),
  );
  const rank = ({id}: WorkflowAgent) => positions.get(id) ?? positions.size;
  return [...agents.values()].toSorted(
    (left, right) => rank(left) - rank(right),
  );
}

/** Agents by phase: the script's declared phases first, then any others */
function groupAgents(
  agents: WorkflowAgent[],
  declaredPhases: Array<string | null>,
): WorkflowRun["phases"] {
  const titles = [
    ...new Set([...declaredPhases, ...agents.map(({phase}) => phase)]),
  ];
  return titles.map((title) => ({
    title,
    agents: agents.filter(({phase}) => phase === title),
  }));
}

// ── Resolution ────────────────────────────────────────────────────────

/**
 * The run `query` names: a main-thread entry ref (`40`) of a launch or its task
 * notification, else an exact run id, else a unique run id prefix, `wf_`
 * optional. An all-digit query is always a ref.
 */
export function resolveWorkflowRun(
  runs: WorkflowRun[],
  events: SessionEvent[],
  query: string,
): WorkflowRun {
  if (/^\d+$/.test(query)) {
    const ref = Number(query);
    const event = events.find((candidate) => candidate.ref === ref);
    if (!event) throw new CliFailure(`Session entry #${ref} does not exist.`);
    const runId =
      event.kind === "tool" || event.kind === "message"
        ? event.workflow?.runId
        : undefined;
    const run = runs.find((candidate) => candidate.runId === runId);
    if (!run) {
      throw new CliFailure(
        `Session entry #${ref} does not name a workflow run.`,
      );
    }
    return run;
  }

  const needle = query.toLowerCase();
  const exact = runs.find((run) => run.runId === needle);
  if (exact) return exact;

  const prefix = needle.startsWith("wf_") ? needle : `wf_${needle}`;
  const matches = runs.filter((run) => run.runId.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliFailure(
      `Ambiguous workflow run prefix "${query}". Matches:\n${matches
        .map((run) => `  ${run.runId}  ${run.name ?? ""}`)
        .join("\n")}`,
    );
  }
  throw new CliFailure(`Unknown workflow run "${query}" in this session.`);
}

// ── Values ────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

import {existsSync} from "node:fs";
import {homedir} from "node:os";
import path from "node:path";
import {CliFailure} from "./cli.js";
import {
  discoverProjects,
  HEX_ID_LENGTH,
  type ProjectRecord,
  type SessionRecord,
  sessionsOf,
} from "./discovery.js";
import {projectEvents, type SessionEvent} from "./events.js";
import {
  mainThread,
  relinkCompactions,
  subagentThread,
  type TranscriptEntry,
} from "./transcripts.js";

export type SubagentRecord = {
  id: string;
  agentType: string | null;
  description: string | null;
  /** The Agent tool call that spawned it */
  toolUseId: string | null;
  /** The workflow run that spawned it, and the run phase it belongs to */
  runId: string | null;
  phase: string | null;
  /** Absolute path to the subagent's JSONL file */
  transcript: string;
};

// ── Transcripts ───────────────────────────────────────────────────────

/**
 * The session's transcript after those of the sessions it continues, oldest
 * first
 */
export function sessionTranscripts(
  session: SessionRecord,
): Array<{id: string; transcript: string}> {
  return [
    ...session.continues,
    {id: session.id, transcript: session.transcript},
  ];
}

/**
 * Subagents spawned anywhere in the session or the sessions it continues,
 * nested ones and workflow agents included. Each keeps one transcript across
 * every continuation, beside a `.meta.json` naming the Agent call that spawned
 * it or its workflow phase. Workflow agents live under `workflows/<runId>/`.
 */
export async function readSubagents(
  session: SessionRecord,
): Promise<SubagentRecord[]> {
  const subagents: SubagentRecord[] = [];
  for (const owner of sessionTranscripts(session)) {
    const directory = path.join(
      path.dirname(owner.transcript),
      owner.id,
      "subagents",
    );
    if (!existsSync(directory)) continue;
    for await (const match of new Bun.Glob("**/agent-*.jsonl").scan(
      directory,
    )) {
      const transcript = path.join(directory, match);
      const metaFile = Bun.file(transcript.replace(/\.jsonl$/, ".meta.json"));
      const meta = (
        (await metaFile.exists()) ? await metaFile.json() : {}
      ) as Record<string, unknown>;
      const field = (key: string) =>
        typeof meta[key] === "string" ? meta[key] : null;
      subagents.push({
        id: path.basename(match, ".jsonl").slice("agent-".length),
        agentType: field("agentType"),
        description: field("description"),
        toolUseId: field("toolUseId"),
        runId: /^workflows\/([^/]+)\//.exec(match)?.[1] ?? null,
        phase: field("workflowPhase"),
        transcript,
      });
    }
  }
  return subagents;
}

async function readTranscript(transcript: string): Promise<TranscriptEntry[]> {
  return Bun.JSONL.parse(
    await Bun.file(transcript).bytes(),
  ) as TranscriptEntry[];
}

/**
 * The session's entries after those of the sessions it continues, each up to
 * where it moved. A new transcript repeats entries from the compaction it moved
 * at, which keep their place in the old transcript.
 */
async function readSessionEntries(
  session: SessionRecord,
): Promise<TranscriptEntry[]> {
  let entries: TranscriptEntry[] = [];
  for (const {id, transcript} of sessionTranscripts(session)) {
    const move = entries.findIndex(
      (entry) =>
        entry.type === "continued-in" && entry.continuedInSessionId === id,
    );
    const earlier = move === -1 ? entries : entries.slice(0, move);
    const repeated = new Set(earlier.map(({uuid}) => uuid));
    entries = [
      ...earlier,
      ...(await readTranscript(transcript)).filter(
        ({uuid}) => uuid === undefined || !repeated.has(uuid),
      ),
    ];
  }
  return entries;
}

/** Every event on the session's main thread, across compactions */
export async function readSessionEvents(
  session: SessionRecord,
  subagents: SubagentRecord[],
): Promise<SessionEvent[]> {
  const entries = relinkCompactions(await readSessionEntries(session));
  return projectEvents(entries, mainThread(entries), subagents);
}

/**
 * Every event on a subagent's thread, across compactions and continuations. A
 * fork's transcript opens with a copy of its parent's thread, so the thread
 * starts at the Agent call that spawned it.
 */
export async function readSubagentEvents(
  session: SessionRecord,
  subagents: SubagentRecord[],
  subagent: SubagentRecord,
): Promise<SessionEvent[]> {
  const entries = relinkCompactions(await readTranscript(subagent.transcript));
  const thread = subagentThread(entries);
  const start = thread.findIndex(
    ({type, message}) =>
      type === "assistant" &&
      Array.isArray((message as {content?: unknown}).content) &&
      (message as {content: Array<{id?: unknown}>}).content.some(
        (block) => block.id === subagent.toolUseId,
      ),
  );
  return projectEvents(
    entries,
    start === -1 ? thread : thread.slice(start),
    subagents,
  );
}

/**
 * The session's main thread, or the subagent thread `subagentQuery` selects: a
 * main-thread entry ref (`131`) linked to a subagent, else a subagent id or
 * unique prefix, `@` optional as the outline shows it.
 */
export async function readThread(
  session: SessionRecord,
  subagentInput: string | undefined,
): Promise<{subagent: SubagentRecord | null; events: SessionEvent[]}> {
  const subagentQuery = subagentInput?.trim();
  const subagents = await readSubagents(session);
  if (subagentQuery === undefined) {
    return {
      subagent: null,
      events: await readSessionEvents(session, subagents),
    };
  }

  const ref = /^\d+$/.exec(subagentQuery)?.[0];
  let subagent: SubagentRecord;
  if (ref === undefined) {
    subagent = resolveSubagent(subagents, subagentQuery.replace(/^@/, ""));
  } else {
    const event = (await readSessionEvents(session, subagents)).find(
      (candidate) => candidate.ref === Number(ref),
    );
    if (!event) throw new CliFailure(`Session entry #${ref} does not exist.`);
    const linked =
      event.kind === "tool" || event.kind === "message" ? event : undefined;
    if (linked?.subagent === undefined) {
      throw new CliFailure(
        linked?.workflow === undefined
          ? `Session entry #${ref} does not name a subagent.`
          : `Session entry #${ref} names workflow run ${linked.workflow.runId}. List its agents with \`agses workflows --run ${ref}\`.`,
      );
    }
    subagent = resolveSubagent(subagents, linked.subagent);
  }
  return {
    subagent,
    events: await readSubagentEvents(session, subagents, subagent),
  };
}

// ── Resolution ────────────────────────────────────────────────────────

function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return path.resolve(input);
}

function pathIsWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** The closest project containing the current directory */
function currentProject(projects: ProjectRecord[]): ProjectRecord | undefined {
  const current = path.resolve(process.cwd());
  return projects
    .filter((project) => pathIsWithin(project.project, current))
    .toSorted((left, right) => right.project.length - left.project.length)[0];
}

/**
 * Exact path, then unique path substring, else the closest project containing
 * the cwd
 */
export function resolveProject(
  projects: ProjectRecord[],
  input?: string,
): ProjectRecord {
  const query = input?.trim();
  if (query === "") throw new CliFailure(`Unknown project "".`);
  if (query !== undefined) {
    const resolvedQuery = expandPath(query);
    const exact = projects.find((project) => project.project === resolvedQuery);
    if (exact) return exact;

    const needle = query.toLowerCase();
    const matches = projects.filter((project) =>
      project.project.toLowerCase().includes(needle),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new CliFailure(
        `Ambiguous project "${query}". Matches:\n${matches.map((project) => `  ${project.project}`).join("\n")}`,
      );
    }
    throw new CliFailure(`Unknown project "${query}".`);
  }

  const closest = currentProject(projects);
  if (closest) return closest;

  throw new CliFailure(
    "Could not resolve a Claude Code project from the current directory. Use --project <path-or-query>.",
  );
}

/**
 * The session `identifier` names in the projects: a 14-char Hex ID (no
 * fallback), an exact UUID, an exact title, then a unique UUID prefix.
 * Continued sessions match all but the title, which they share with the session
 * continuing them. Ambiguous candidates name their project when several were
 * searched.
 */
function matchSession(
  projects: ProjectRecord[],
  identifier: string,
): SessionRecord | undefined {
  const listed = sessionsOf(projects);
  const sessions = [
    ...listed,
    ...projects.flatMap((project) => project.continued),
  ];
  const needle = identifier.toLowerCase();
  if (needle === "") return undefined;
  const pick = (
    matches: SessionRecord[],
    kind: string,
  ): SessionRecord | undefined => {
    if (matches.length <= 1) return matches[0];
    throw new CliFailure(
      `Ambiguous session ${kind} "${identifier}". Matches:\n${matches
        .map((session) =>
          projects.length === 1
            ? `  ${session.hexId}  ${session.id}  ${session.title}`
            : `  ${session.hexId}  ${session.id}  ${session.project}  ${session.title}`,
        )
        .join("\n")}`,
    );
  };

  if (needle.length === HEX_ID_LENGTH && /^[0-9a-f]+$/.test(needle)) {
    return pick(
      sessions.filter((s) => s.hexId === needle),
      "Hex ID",
    );
  }

  return (
    sessions.find((s) => s.id === needle) ??
    pick(
      listed.filter((s) => s.title.toLowerCase() === needle),
      "title",
    ) ??
    pick(
      sessions.filter((s) => s.id.startsWith(needle)),
      "ID prefix",
    )
  );
}

/**
 * Resolve SESSION: a `.jsonl` path selects its session in any project. Other
 * forms match within `--project`; without it, within the closest project
 * containing the cwd, then across all projects. Omitted selects the project's
 * most recently active session.
 */
export async function resolveSession(
  input: string | undefined,
  projectQuery: string | undefined,
): Promise<SessionRecord> {
  const identifier = input?.trim();
  const projects = await discoverProjects();

  if (identifier?.toLowerCase().endsWith(".jsonl")) {
    const id = path.basename(identifier, ".jsonl");
    const session = projects
      .flatMap((project) => [...project.sessions, ...project.continued])
      .find((s) => s.id === id);
    if (!session)
      throw new CliFailure(`No Claude Code session found for "${identifier}".`);
    if (projectQuery !== undefined) {
      const project = resolveProject(projects, projectQuery);
      if (session.project !== project.project) {
        throw new CliFailure(
          `Session ${id} belongs to ${session.project}, not ${project.project}.`,
        );
      }
    }
    return session;
  }

  if (identifier === undefined) {
    return resolveProject(projects, projectQuery).sessions[0]!;
  }

  const unknown = new CliFailure(
    `Unknown session ID, prefix, Hex ID, or title "${identifier}".`,
  );
  if (projectQuery !== undefined) {
    const match = matchSession(
      [resolveProject(projects, projectQuery)],
      identifier,
    );
    if (match) return match;
    throw unknown;
  }

  const current = currentProject(projects);
  const match =
    (current && matchSession([current], identifier)) ??
    matchSession(projects, identifier);
  if (match) return match;
  throw unknown;
}

/** Exact subagent id, then a unique id prefix */
export function resolveSubagent(
  subagents: SubagentRecord[],
  identifier: string,
): SubagentRecord {
  const needle = identifier.toLowerCase();
  if (needle === "") {
    throw new CliFailure(`Unknown subagent "${identifier}" in this session.`);
  }
  const exact = subagents.find((subagent) => subagent.id === needle);
  if (exact) return exact;

  const matches = subagents.filter((subagent) =>
    subagent.id.startsWith(needle),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliFailure(
      `Ambiguous subagent ID prefix "${identifier}". Matches:\n${matches
        .map((subagent) => `  ${subagent.id}  ${subagent.description ?? ""}`)
        .join("\n")}`,
    );
  }
  throw new CliFailure(`Unknown subagent "${identifier}" in this session.`);
}

export function sessionFrontmatter(
  session: SessionRecord,
  subagent: SubagentRecord | null,
): Record<string, string | null> {
  const fields: Record<string, string | null> = {
    hexId: session.hexId,
    title: session.title,
    created: session.created,
    project: session.project,
    transcript: session.transcript,
  };
  if (subagent) {
    fields.subagent = subagent.id;
    fields.agentType = subagent.agentType;
    fields.description = subagent.description;
    if (subagent.runId !== null) {
      fields.workflow = subagent.runId;
      fields.phase = subagent.phase;
    }
    fields.transcript = subagent.transcript;
  }
  return fields;
}

import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import path from "node:path";
import {
  readSessionMetadata,
  type SessionMetadata,
  type TranscriptEntry,
} from "./transcripts.js";

export const HEX_ID_LENGTH = 14;
/** How much of a transcript's end to search for its `continued-in` entry */
const TAIL_BYTES = 65_536;
const FOLDER_NAME_LENGTH = 200;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionRecord = {
  id: string;
  hexId: string;
  project: string;
  name: string;
  created: string | null;
  lastActivity: string;
  size: number;
  firstPrompt: string | null;
  /** Absolute path to the session's JSONL file */
  transcript: string;
  /**
   * Sessions this one continues from transcripts that hold its earlier history,
   * oldest first
   */
  continues: Array<{id: string; transcript: string}>;
};

export type ProjectRecord = {
  project: string;
  sessions: SessionRecord[];
  /** Sessions continued in a new transcript, which lists leave out */
  continued: SessionRecord[];
};

/**
 * All sessions, newest first, grouped into projects: the directory each
 * session's folder is named after, else the session's first recorded cwd. A
 * continued session joins the project of the listed session that continues it.
 * Sessions without a recorded cwd cannot be attributed to a project.
 */
export async function discoverProjects(): Promise<ProjectRecord[]> {
  const transcripts = await findTranscripts();
  const sessions = await Promise.all(
    [...transcripts].map(async ([id, transcript]) => ({
      id,
      transcript,
      metadata: await readSessionMetadata(transcript),
    })),
  );
  const folderPaths = new Map<string, string>();
  for (const {transcript, metadata} of sessions) {
    const folder = path.basename(path.dirname(transcript));
    if (metadata?.cwd && namesFolder(metadata.cwd, folder)) {
      folderPaths.set(folder, metadata.cwd);
    }
  }
  const ownProjects = new Map<string, string>();
  for (const {id, transcript, metadata} of sessions) {
    if (!metadata?.cwd) continue;
    const folder = path.basename(path.dirname(transcript));
    ownProjects.set(id, folderPaths.get(folder) ?? metadata.cwd);
  }

  // A session stays listed until a listed session continues it
  const continuations = new Map(
    [...(await findContinuations(transcripts))].filter(([next]) =>
      ownProjects.has(next),
    ),
  );
  const continuedIn = new Map(
    [...continuations].map(([next, earlier]) => [earlier, next]),
  );
  const projectOf = (id: string): string | undefined => {
    const seen = new Set([id]);
    let latest = id;
    for (
      let next = continuedIn.get(latest);
      next !== undefined && !seen.has(next);
      next = continuedIn.get(latest)
    ) {
      seen.add(next);
      latest = next;
    }
    return ownProjects.get(latest);
  };

  const byProject = new Map<string, ProjectRecord>();
  for (const {id, transcript, metadata} of sessions.toSorted(
    (left, right) =>
      (right.metadata?.lastModified ?? 0) - (left.metadata?.lastModified ?? 0),
  )) {
    const project = projectOf(id);
    if (!metadata || project === undefined) continue;
    const record = byProject.get(project) ?? {
      project,
      sessions: [],
      continued: [],
    };
    const continues: SessionRecord["continues"] = [];
    for (
      let earlier = continuations.get(id);
      earlier !== undefined &&
      !continues.some((session) => session.id === earlier);
      earlier = continuations.get(earlier)
    ) {
      const earlierTranscript = transcripts.get(earlier);
      if (earlierTranscript === undefined) break;
      continues.unshift({id: earlier, transcript: earlierTranscript});
    }
    const session = sessionRecord(id, project, metadata, transcript, continues);
    if (continuedIn.has(id)) record.continued.push(session);
    else record.sessions.push(session);
    byProject.set(project, record);
  }

  return [...byProject.values()].map((project) => ({
    ...project,
    sessions: project.sessions.toSorted((left, right) =>
      right.lastActivity.localeCompare(left.lastActivity),
    ),
  }));
}

/** Every session of the projects, newest activity first */
export function sessionsOf(projects: ProjectRecord[]): SessionRecord[] {
  return projects
    .flatMap((project) => project.sessions)
    .toSorted((left, right) =>
      right.lastActivity.localeCompare(left.lastActivity),
    );
}

/**
 * Whether Claude Code files sessions started in `cwd` under `folder`: the path
 * with every other character than a letter or digit replaced by `-`, cut and
 * hashed past 200 characters
 */
function namesFolder(cwd: string, folder: string): boolean {
  const name = cwd.replaceAll(/[^a-zA-Z0-9]/g, "-");
  return name.length <= FOLDER_NAME_LENGTH
    ? name === folder
    : folder.startsWith(`${name.slice(0, FOLDER_NAME_LENGTH)}-`);
}

/** Session UUID → transcript path */
async function findTranscripts(): Promise<Map<string, string>> {
  const projectsDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
    "projects",
  );
  const transcripts = new Map<string, string>();
  if (!existsSync(projectsDir)) return transcripts;
  for await (const match of new Bun.Glob("*/*.jsonl").scan(projectsDir)) {
    const id = path.basename(match, ".jsonl");
    if (SESSION_ID_PATTERN.test(id)) {
      transcripts.set(id, path.join(projectsDir, match));
    }
  }
  return transcripts;
}

/**
 * Continuing session UUID → UUID of the session it continues. Resuming a
 * compacted session can move it to a new transcript that repeats the
 * compaction. The old transcript then ends with a `continued-in` entry naming
 * the new session. Search only the tail, so a link is missed if the old session
 * ran on long after it.
 */
async function findContinuations(
  transcripts: Map<string, string>,
): Promise<Map<string, string>> {
  const continuations = new Map<string, string>();
  await Promise.all(
    [...transcripts].map(async ([id, transcript]) => {
      const file = Bun.file(transcript);
      const start = Math.max(0, file.size - TAIL_BYTES);
      const lines = (await file.slice(start).text()).split("\n");
      // A cut first line is not JSON
      const entry = lines
        .slice(start > 0 ? 1 : 0)
        .findLast((line) => line.includes('"type":"continued-in"'));
      if (entry === undefined) return;
      const {continuedInSessionId} = JSON.parse(entry) as TranscriptEntry;
      if (typeof continuedInSessionId === "string") {
        continuations.set(continuedInSessionId, id);
      }
    }),
  );
  return continuations;
}

function sessionRecord(
  id: string,
  project: string,
  metadata: SessionMetadata,
  transcript: string,
  continues: SessionRecord["continues"],
): SessionRecord {
  return {
    id,
    hexId: createHash("sha256")
      .update(id, "utf8")
      .digest("hex")
      .slice(0, HEX_ID_LENGTH),
    project,
    name: metadata.name,
    created:
      metadata.created === null
        ? null
        : new Date(metadata.created).toISOString(),
    lastActivity: new Date(metadata.lastModified).toISOString(),
    size: metadata.size,
    firstPrompt: metadata.firstPrompt,
    transcript,
    continues,
  };
}

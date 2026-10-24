import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {cpSync, mkdtempSync, rmSync, utimesSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

const ENTRY = path.join(import.meta.dir, "../src/index.ts");
const FIXTURES = path.join(import.meta.dir, "fixtures");

const THREAD = "a0000000-0000-4000-8000-000000000001";
const COMPACTIONS = "a0000000-0000-4000-8000-000000000002";
const CONTINUED = "a0000000-0000-4000-8000-000000000003";
const CONTINUING = "a0000000-0000-4000-8000-000000000004";
const DELEGATION = "a0000000-0000-4000-8000-000000000005";
const RENAMED = "b0000000-0000-4000-8000-000000000001";
const AUTO_TITLED = "b0000000-0000-4000-8000-000000000002";
const UNTITLED = "b0000000-0000-4000-8000-000000000003";
const LARGE_FIRST_ENTRY = "b0000000-0000-4000-8000-000000000004";
const MOVED = "c0000000-0000-4000-8000-000000000001";
const MOVED_CONTINUING = "b0000000-0000-4000-8000-000000000005";

const SPAWNED_AGENT = "a0000000000000005";
const FORKED_AGENT = "a0000000000000006";
const WORKFLOW_AGENT = "a0000000000000007";
const CONTINUED_AGENT = "a0000000000000003";

type Session = {id: string; project: string; title: string};

type OutlineEvent = {
  ref: number;
  kind: string;
  label: string;
  preview: string;
  subagent?: string;
  workflow?: {runId: string};
};

type Outline = {
  session: Session;
  subagent: {id: string} | null;
  events: OutlineEvent[];
};

type ReadEvent = Record<string, unknown> & {kind: string; name?: string};

type SearchMatch = {session: Session; subagent: {id: string} | null};

let configDir: string;

beforeAll(async () => {
  configDir = mkdtempSync(path.join(tmpdir(), "agses-test-"));
  cpSync(FIXTURES, configDir, {recursive: true});
  // Session activity is the transcript's mtime, which a checkout does not keep
  for await (const match of new Bun.Glob("projects/**/*.jsonl").scan(
    configDir,
  )) {
    const file = path.join(configDir, match);
    const stamps = [
      ...(await Bun.file(file).text()).matchAll(/"timestamp":"([^"]+)"/g),
    ].map(([, stamp]) => new Date(stamp!));
    const latest = stamps.toSorted((a, b) => b.getTime() - a.getTime())[0];
    if (latest) utimesSync(file, latest, latest);
  }
});

afterAll(() => rmSync(configDir, {recursive: true, force: true}));

/** Run the CLI outside every fixture project, isolated from the real config */
async function agses(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd: configDir,
    env: {HOME: configDir, CLAUDE_CONFIG_DIR: configDir, ...env},
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {stdout, stderr, code};
}

/** Run a command that succeeds, parsing its JSON output as `T` */
async function json<T>(...args: string[]): Promise<T> {
  const {stdout, stderr, code} = await agses([...args, "--format", "json"]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout) as T;
}

async function outline(...args: string[]) {
  return (await json<Outline>("outline", ...args)).events;
}

async function matches(...args: string[]) {
  const {matches: found} = await json<{matches: SearchMatch[]}>(
    "search",
    ...args,
  );
  return found.map(({session, subagent}) => [session.id, subagent?.id ?? null]);
}

async function toolResults(...args: string[]) {
  const {events} = await json<{events: ReadEvent[]}>("read", ...args);
  return events
    .filter(({kind}) => kind === "tool")
    .map(({name, result}) => ({name, result}));
}

/** A thread as readable steps: tools by name, extras by kind in parentheses */
function steps(events: OutlineEvent[]): string[] {
  return events.map(({kind, label, preview}) => {
    if (kind === "extra") return `(${label})`;
    if (kind === "tool") return label;
    return `${label}: ${preview}`;
  });
}

function refOf(events: OutlineEvent[], step: string): number {
  const event = events.find((candidate) => steps([candidate])[0] === step);
  if (!event) throw new Error(`No event "${step}"`);
  return event.ref;
}

// ─── Discovery ──────────────────────────────────────────────────────────────

describe("discovery", () => {
  test("groups sessions into projects by recorded cwd, newest activity first", async () => {
    const {projects} = await json<{
      projects: Array<{project: string; sessions: number}>;
    }>("projects");
    expect(projects.map(({project, sessions}) => [project, sessions])).toEqual([
      ["/work/alpha", 4],
      ["/work/beta", 5],
    ]);

    const {sessions} = await json<{sessions: Session[]}>("sessions", "--all");
    expect(sessions.map(({id, project}) => [id, project])).toEqual([
      [DELEGATION, "/work/alpha"],
      [CONTINUING, "/work/alpha"],
      [COMPACTIONS, "/work/alpha"],
      [THREAD, "/work/alpha"],
      [MOVED_CONTINUING, "/work/beta"],
      // Its cwd first appears beyond the first 64 KB, behind a pasted image
      [LARGE_FIRST_ENTRY, "/work/beta"],
      [UNTITLED, "/work/beta"],
      [AUTO_TITLED, "/work/beta"],
      [RENAMED, "/work/beta"],
    ]);
  });

  test("titles a session by its rename, else its auto title, else its first prompt", async () => {
    const {sessions} = await json<{sessions: Session[]}>(
      "sessions",
      "--project",
      "beta",
    );
    const titles = new Map(sessions.map(({id, title}) => [id, title]));
    expect(titles.get(RENAMED)).toBe("Renamed session");
    expect(titles.get(AUTO_TITLED)).toBe("Cache layer explanation");

    const fallback = titles.get(UNTITLED) ?? "";
    expect(fallback).toStartWith(
      "Untitled sessions fall back to their first prompt.",
    );
    expect(fallback).not.toContain("\n");
    expect(fallback.length).toBeLessThanOrEqual(201);

    const {session} = await json<Outline>("outline", "renamed SESSION");
    expect(session.id).toBe(RENAMED);
  });

  test("hides a continued session from lists but still selects it", async () => {
    const {sessions} = await json<{sessions: Session[]}>("sessions", "--all");
    expect(sessions.map(({id}) => id)).not.toContain(CONTINUED);

    const {session} = await json<Outline>("outline", CONTINUED);
    expect(session.id).toBe(CONTINUED);
  });

  test("files a session continued in another project under that project", async () => {
    const {session} = await json<Outline>(
      "outline",
      MOVED,
      "--project",
      "beta",
    );
    expect(session).toMatchObject({id: MOVED, project: "/work/beta"});
  });
});

// ─── Threads ────────────────────────────────────────────────────────────────

describe("threads", () => {
  test("follow the latest branch, leaving an abandoned one out", async () => {
    expect(steps(await outline(THREAD))).toEqual([
      "user: First prompt with a second line",
      "assistant: First answer",
      "user: Second prompt",
      "Read",
      "Bash",
      "user: Queued while busy",
      "assistant: Final answer",
    ]);

    const {stdout} = await agses([
      "read",
      THREAD,
      "--extra",
      "--format",
      "json",
    ]);
    expect(stdout.toLowerCase()).not.toContain("abandoned");
  });

  test("span every compaction", async () => {
    expect(steps(await outline(COMPACTIONS))).toEqual([
      "user: Before the compactions",
      "assistant: Answer one",
      "compaction: Summary one",
      "user: Between the compactions",
      "assistant: Answer two",
      "compaction: Summary two",
      "user: After the compactions",
      "assistant: Answer three",
    ]);
  });

  test("read a continued session's history first, without repeats", async () => {
    expect(steps(await outline(CONTINUING))).toEqual([
      "user: Old history prompt",
      "Agent",
      "assistant: Old answer",
      "user: New history prompt",
      "assistant: New answer",
    ]);
  });

  test("keep every parallel tool call with its result", async () => {
    expect(await toolResults(THREAD)).toEqual([
      {name: "Read", result: {text: "line one\nline two", error: false}},
      {name: "Bash", result: {text: "Command failed: make build", error: true}},
    ]);
    expect(await toolResults(DELEGATION, "--subagent", SPAWNED_AGENT)).toEqual([
      {name: "Read", result: {text: "spec contents", error: false}},
      {name: "Grep", result: {text: "No matches", error: false}},
    ]);
  });

  test("keep a prompt queued while the agent was busy, once, in its place", async () => {
    const thread = steps(await outline(THREAD));
    const queued = thread.filter((step) => step.includes("Queued while busy"));
    expect(queued).toEqual(["user: Queued while busy"]);
    expect(thread.indexOf("user: Queued while busy")).toBe(
      thread.indexOf("Bash") + 1,
    );
  });
});

// ─── Refs ───────────────────────────────────────────────────────────────────

describe("refs", () => {
  test("hold with and without extras", async () => {
    const shown = await outline(THREAD);
    const all = await outline(THREAD, "--extra");
    expect(all.length).toBeGreaterThan(shown.length);
    for (const event of shown) {
      expect(all.find(({ref}) => ref === event.ref)).toEqual(event);
    }
  });

  test("read the full event, extras included", async () => {
    const all = await outline(THREAD, "--extra");
    const entry = async (step: string) =>
      (
        await json<{event: ReadEvent}>(
          "read",
          THREAD,
          "--entry",
          String(refOf(all, step)),
        )
      ).event;

    expect(await entry("user: First prompt with a second line")).toMatchObject({
      kind: "message",
      role: "user",
      text: "First prompt\nwith a second line",
    });
    expect(await entry("Read")).toMatchObject({
      kind: "tool",
      input: {file_path: "/work/alpha/notes.md"},
      result: {text: "line one\nline two", error: false},
    });
    expect(await entry("(turn_duration)")).toMatchObject({
      kind: "extra",
      name: "turn_duration",
    });

    const {stdout} = await agses([
      "read",
      THREAD,
      "--extra",
      "--format",
      "json",
    ]);
    expect(stdout).not.toContain("Private reasoning");
  });
});

// ─── Subagents and workflows ────────────────────────────────────────────────

describe("subagents", () => {
  test("follow a spawned subagent, a fork and a workflow run from the parent", async () => {
    const parent = await outline(DELEGATION);
    const [spawn, fork, workflow] = parent.filter(
      ({kind}) => kind === "tool",
    ) as [OutlineEvent, OutlineEvent, OutlineEvent];
    expect([spawn.subagent, fork.subagent, workflow.workflow?.runId]).toEqual([
      SPAWNED_AGENT,
      FORKED_AGENT,
      "wf_fixture-001",
    ]);

    const spawned = await json<Outline>(
      "outline",
      DELEGATION,
      "--subagent",
      String(spawn.ref),
    );
    expect(spawned.subagent?.id).toBe(SPAWNED_AGENT);
    expect(steps(spawned.events)).toEqual([
      "user: Do the spawned task",
      "Read",
      "Grep",
      "assistant: Spawned answer",
    ]);
    expect(spawned.events[0]?.ref).toBe(1);

    // A fork's transcript copies the parent thread before its spawning call
    const forked = await outline(DELEGATION, "--subagent", String(fork.ref));
    expect(steps(forked)).toEqual([
      "Agent",
      "user: Do the forked task",
      "assistant: Fork answer",
    ]);

    const {run} = await json<{
      run: {runId: string; phases: Array<{agents: Array<{id: string}>}>};
    }>("workflows", DELEGATION, "--run", String(workflow.ref));
    expect(run.runId).toBe("wf_fixture-001");
    expect(run.phases.flatMap(({agents}) => agents.map(({id}) => id))).toEqual([
      WORKFLOW_AGENT,
    ]);
  });

  test("find a subagent of the session a continuation moved from", async () => {
    expect(
      steps(await outline(CONTINUING, "--subagent", CONTINUED_AGENT)),
    ).toEqual(["user: Check the old code", "assistant: The old code is fine."]);
  });
});

// ─── Search ─────────────────────────────────────────────────────────────────

describe("search", () => {
  test("finds history across compactions and continuations, not abandoned branches", async () => {
    expect(await matches("Before the compactions", "--all")).toEqual([
      [COMPACTIONS, null],
    ]);
    expect(await matches("Old history prompt", "--all")).toEqual([
      [CONTINUING, null],
    ]);
    expect(await matches("Abandoned", "--all")).toEqual([]);
  });

  test("scopes to a project and reaches subagents on request", async () => {
    expect(await matches("Answer one", "--project", "beta")).toEqual([]);
    expect(await matches("Answer one", "--project", "alpha")).toEqual([
      [COMPACTIONS, null],
    ]);

    expect(await matches("Spawned answer", "--all")).toEqual([]);
    expect(await matches("Spawned answer", "--all", "--subagents")).toEqual([
      [DELEGATION, SPAWNED_AGENT],
    ]);
  });
});

// ─── Tokens ─────────────────────────────────────────────────────────────────

describe("tokens", () => {
  test("counts through the API, preferring the agses key", async () => {
    const requests: Array<{key: string | null; body: unknown}> = [];
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: Array<{content: string}>;
        };
        requests.push({key: request.headers.get("x-api-key"), body});
        if (body.messages[0]?.content === "rejected input") {
          return Response.json(
            {
              type: "error",
              error: {type: "invalid_request_error", message: "Bad input"},
            },
            {status: 400},
          );
        }
        return Response.json({input_tokens: 42});
      },
    });
    const env = {
      ANTHROPIC_BASE_URL: `http://localhost:${server.port}`,
      AGSES_ANTHROPIC_API_KEY: "agses-key",
      ANTHROPIC_API_KEY: "claude-key",
    };
    const input = path.join(configDir, "input.txt");

    await Bun.write(input, "count these words");
    expect(await agses(["tokens", input], env)).toMatchObject({
      stdout: "42\n",
      code: 0,
    });
    expect(requests[0]).toMatchObject({
      key: "agses-key",
      body: {messages: [{role: "user", content: "count these words"}]},
    });

    await Bun.write(input, "rejected input");
    const rejected = await agses(["tokens", input], env);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("Bad input");
  });
});

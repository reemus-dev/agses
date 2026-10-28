// Writes the Claude Code transcripts in test/fixtures/projects
import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "fixtures/projects");
rmSync(root, {recursive: true, force: true});

type Entry = Record<string, unknown>;

let entryCount = 0;
const uuid = () =>
  `e0000000-0000-4000-8000-${String(++entryCount).padStart(12, "0")}`;
const sessionUuid = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One transcript's entries, timestamped a minute apart from `start` */
function transcript(
  sessionId: string,
  cwd: string,
  start: string,
  extra: Entry = {},
) {
  const entries: Entry[] = [];
  let clock = Date.parse(start);
  let last: string | null = null;
  const stamp = () => new Date((clock += 60_000)).toISOString();
  const push = (entry: Entry) => {
    entries.push(entry);
    return entry;
  };

  /** A chain entry, parented on the previous one unless `parent` says otherwise */
  const node = (fields: Entry, parent: string | null | undefined = last) => {
    const id = uuid();
    const {message, ...rest} = fields;
    const entry: Entry = {
      parentUuid: parent,
      isSidechain: false,
      ...extra,
      ...rest,
    };
    if (message !== undefined) entry.message = message;
    Object.assign(entry, {
      uuid: id,
      timestamp: stamp(),
      userType: "external",
      cwd,
      sessionId,
      version: "2.1.0",
    });
    push(entry);
    last = id;
    return entry;
  };

  return {
    entries,
    push,
    node,
    get last() {
      return last;
    },
    set last(value: string | null) {
      last = value;
    },
    user: (content: unknown, fields: Entry = {}, parent?: string | null) =>
      node({type: "user", message: {role: "user", content}, ...fields}, parent),
    assistant: (messageId: string, content: Entry[], parent?: string | null) =>
      node(
        {
          type: "assistant",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: "claude-opus-4-5",
            content,
          },
        },
        parent,
      ),
    result: (
      call: Entry,
      toolUseId: string,
      text: string,
      fields: Entry = {},
      isError = false,
    ) =>
      node(
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: text,
                is_error: isError,
              },
            ],
          },
          sourceToolAssistantUUID: call.uuid,
          ...fields,
        },
        call.uuid as string,
      ),
    meta: (fields: Entry) => push({...fields, sessionId}),
  };
}

const text = (value: string) => ({type: "text", text: value});
const toolUse = (id: string, name: string, input: Entry) => ({
  type: "tool_use",
  id,
  name,
  input,
});

function write(project: string, file: string, lines: unknown[]) {
  const target = path.join(root, project, file);
  mkdirSync(path.dirname(target), {recursive: true});
  writeFileSync(
    target,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

const ALPHA = "-work-alpha";
const BETA = "-work-beta";

// ─── Beta: names and a large first entry ────────────────────────────────────

{
  const id = sessionUuid("b", 1);
  const t = transcript(id, "/work/beta", "2026-01-01T01:00:00Z");
  t.user("Fix the login bug");
  t.assistant("msg_b1", [text("Fixed the login bug.")]);
  t.meta({type: "ai-title", aiTitle: "Login bug fix"});
  t.meta({type: "custom-title", customTitle: "Renamed session"});
  write(BETA, `${id}.jsonl`, t.entries);
}
{
  const id = sessionUuid("b", 2);
  const t = transcript(id, "/work/beta", "2026-01-01T02:00:00Z");
  t.user("Explain the cache layer");
  t.assistant("msg_b2", [text("The cache layer stores responses.")]);
  t.meta({type: "ai-title", aiTitle: "Cache layer explanation"});
  write(BETA, `${id}.jsonl`, t.entries);
}
{
  const id = sessionUuid("b", 3);
  const t = transcript(id, "/work/beta", "2026-01-01T03:00:00Z");
  const sentence = "Unnamed sessions fall back to their first prompt. ";
  t.user(`${sentence.repeat(3)}\n${sentence.repeat(5)}`);
  t.assistant("msg_b3", [text("Understood.")]);
  write(BETA, `${id}.jsonl`, t.entries);
}
{
  // The first entry's cwd sits past the first 64 KB, behind a pasted image
  const id = sessionUuid("b", 4);
  const t = transcript(id, "/work/beta", "2026-01-01T04:00:00Z");
  t.meta({type: "permission-mode", permissionMode: "default"});
  t.user([
    text("Describe this screenshot"),
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "A".repeat(80_000),
      },
    },
  ]);
  t.assistant("msg_b4", [text("It shows a login form.")]);
  t.meta({type: "ai-title", aiTitle: "Screenshot description"});
  write(BETA, `${id}.jsonl`, t.entries);
}

// ─── Beta: a session started in another project and continued here ───────────

{
  const oldId = sessionUuid("c", 1);
  const newId = sessionUuid("b", 5);
  const old = transcript(oldId, "/work/gamma", "2026-01-01T05:00:00Z");
  old.user("Started in gamma");
  old.assistant("msg_g1", [text("Gamma answer")]);
  old.meta({type: "ai-title", aiTitle: "Moved fixture"});
  const repeated = old.entries.filter((entry) => entry.uuid !== undefined);
  old.meta({
    type: "continued-in",
    timestamp: "2026-01-01T05:30:00.000Z",
    continuedInSessionId: newId,
  });
  write("-work-gamma", `${oldId}.jsonl`, old.entries);

  const next = transcript(newId, "/work/beta", "2026-01-01T06:00:00Z");
  next.meta({type: "ai-title", aiTitle: "Moved fixture"});
  for (const entry of repeated) next.push({...entry, sessionId: newId});
  next.last = repeated.at(-1)!.uuid as string;
  next.user("Continued in beta");
  next.assistant("msg_g2", [text("Beta answer")]);
  write(BETA, `${newId}.jsonl`, next.entries);
}

// ─── Alpha: one thread with branches, parallel calls, extras, a queued prompt

{
  const id = sessionUuid("a", 1);
  const t = transcript(id, "/work/alpha", "2026-01-02T01:00:00Z");
  t.user("First prompt\nwith a second line");
  t.assistant("msg_a1", [
    {type: "thinking", thinking: "Private reasoning", signature: "sig"},
  ]);
  t.assistant("msg_a1", [text("First answer")]);
  const turnEnd = t.node({
    type: "system",
    subtype: "turn_duration",
    durationMs: 1200,
    isMeta: false,
  });

  // Abandoned branch: the user rewound and edited the next prompt
  t.user("Abandoned prompt", {}, turnEnd.uuid as string);
  const abandonedCall = t.assistant("msg_a2", [
    toolUse("toolu_abandoned", "Bash", {command: "ls"}),
  ]);
  t.result(abandonedCall, "toolu_abandoned", "abandoned listing");
  t.node({
    type: "attachment",
    attachment: {type: "output_style", style: "abandoned-style"},
  });
  t.assistant("msg_a3", [text("Abandoned answer")]);

  // Live branch, with two parallel tool calls whose results each hang off their call
  t.user("Second prompt", {}, turnEnd.uuid as string);
  const callA = t.assistant("msg_a4", [
    toolUse("toolu_read", "Read", {file_path: "/work/alpha/notes.md"}),
  ]);
  const callB = t.assistant("msg_a4", [
    toolUse("toolu_bash", "Bash", {command: "make build"}),
  ]);
  t.result(callA, "toolu_read", "line one\nline two");
  t.result(callB, "toolu_bash", "Command failed: make build", {}, true);
  t.node({
    type: "attachment",
    attachment: {
      type: "queued_command",
      prompt: "Queued while busy",
      source_uuid: "f0000000-0000-4000-8000-000000000001",
      commandMode: "prompt",
      origin: {kind: "human"},
    },
    rendered: [{content: "Queued while busy"}],
    renderedRole: "system",
  });
  t.assistant("msg_a5", [text("Final answer")]);
  t.meta({type: "ai-title", aiTitle: "Thread fixture"});
  write(ALPHA, `${id}.jsonl`, t.entries);
}

// ─── Alpha: two compactions ─────────────────────────────────────────────────

{
  const id = sessionUuid("a", 2);
  const t = transcript(id, "/work/alpha", "2026-01-02T02:00:00Z");
  t.user("Before the compactions");
  const answerOne = t.assistant("msg_c1", [text("Answer one")]);
  t.node(
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      logicalParentUuid: answerOne.uuid,
      compactMetadata: {trigger: "manual", preTokens: 1000},
    },
    null,
  );
  t.user("Summary one", {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  const between = t.user("Between the compactions");
  const answerTwo = t.assistant("msg_c2", [text("Answer two")]);
  // The second compaction keeps the latest turn
  const boundary = t.node(
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      logicalParentUuid: answerTwo.uuid,
    },
    null,
  );
  const summary = t.user("Summary two", {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  boundary.compactMetadata = {
    trigger: "auto",
    preTokens: 2000,
    preservedSegment: {
      headUuid: between.uuid,
      anchorUuid: summary.uuid,
      tailUuid: answerTwo.uuid,
    },
  };
  t.user("After the compactions");
  t.assistant("msg_c3", [text("Answer three")]);
  t.meta({type: "ai-title", aiTitle: "Compaction fixture"});
  write(ALPHA, `${id}.jsonl`, t.entries);
}

// ─── Alpha: a session continued in a new transcript ─────────────────────────

{
  const oldId = sessionUuid("a", 3);
  const newId = sessionUuid("a", 4);
  const old = transcript(oldId, "/work/alpha", "2026-01-02T03:00:00Z");
  old.user("Old history prompt");
  const spawn = old.assistant("msg_o1", [
    toolUse("toolu_old_agent", "Agent", {
      description: "Old subagent",
      prompt: "Check the old code",
      subagent_type: "general-purpose",
    }),
  ]);
  old.result(spawn, "toolu_old_agent", "Old subagent report");
  old.assistant("msg_o2", [text("Old answer")]);
  old.meta({type: "ai-title", aiTitle: "Continued fixture"});
  const repeated = old.entries.filter((entry) => entry.uuid !== undefined);
  old.meta({
    type: "continued-in",
    timestamp: "2026-01-02T03:30:00.000Z",
    continuedInSessionId: newId,
  });
  write(ALPHA, `${oldId}.jsonl`, old.entries);

  const agentId = "a0000000000000003";
  const sub = transcript(oldId, "/work/alpha", "2026-01-02T03:01:00Z", {
    isSidechain: true,
    agentId,
  });
  sub.user("Check the old code", {}, null);
  sub.assistant("msg_os1", [text("The old code is fine.")]);
  write(ALPHA, `${oldId}/subagents/agent-${agentId}.jsonl`, sub.entries);
  writeFileSync(
    path.join(root, ALPHA, `${oldId}/subagents/agent-${agentId}.meta.json`),
    JSON.stringify({
      agentType: "general-purpose",
      description: "Old subagent",
      toolUseId: "toolu_old_agent",
    }),
  );

  const next = transcript(newId, "/work/alpha", "2026-01-02T04:00:00Z");
  next.meta({type: "ai-title", aiTitle: "Continued fixture"});
  for (const entry of repeated) next.push({...entry, sessionId: newId});
  next.last = repeated.at(-1)!.uuid as string;
  next.user("New history prompt");
  next.assistant("msg_n1", [text("New answer")]);
  write(ALPHA, `${newId}.jsonl`, next.entries);
}

// ─── Alpha: delegation to a subagent, a fork and a workflow ─────────────────

{
  const id = sessionUuid("a", 5);
  const spawnedId = "a0000000000000005";
  const forkId = "a0000000000000006";
  const workflowAgentId = "a0000000000000007";
  const runId = "wf_fixture-001";
  const t = transcript(id, "/work/alpha", "2026-01-02T05:00:00Z");
  t.user("Delegate the work");
  const spawnInput = {
    description: "Spawned task",
    prompt: "Do the spawned task",
    subagent_type: "general-purpose",
  };
  const spawn = t.assistant("msg_d1", [
    toolUse("toolu_spawn", "Agent", spawnInput),
  ]);
  t.result(spawn, "toolu_spawn", "Spawned report");
  const forkInput = {description: "Forked task", prompt: "Do the forked task"};
  const fork = t.assistant("msg_d2", [
    toolUse("toolu_fork", "Agent", forkInput),
  ]);
  t.result(fork, "toolu_fork", "Fork report");
  const workflow = t.assistant("msg_d3", [
    toolUse("toolu_workflow", "Workflow", {script: "fixture.js"}),
  ]);
  t.result(workflow, "toolu_workflow", "Workflow launched", {
    toolUseResult: {
      status: "async_launched",
      taskId: "wtask0001",
      runId,
      workflowName: "fixture-flow",
      summary: "Fixture run",
    },
  });
  t.assistant("msg_d4", [text("All delegated")]);
  t.meta({type: "ai-title", aiTitle: "Delegation fixture"});
  write(ALPHA, `${id}.jsonl`, t.entries);

  const meta = (agentId: string, fields: Entry, dir = "subagents") =>
    writeFileSync(
      path.join(root, ALPHA, id, dir, `agent-${agentId}.meta.json`),
      JSON.stringify(fields),
    );

  const spawned = transcript(id, "/work/alpha", "2026-01-02T05:01:00Z", {
    isSidechain: true,
    agentId: spawnedId,
  });
  spawned.user("Do the spawned task", {}, null);
  const subRead = spawned.assistant("msg_s0", [
    toolUse("toolu_sub_read", "Read", {file_path: "/work/alpha/spec.md"}),
  ]);
  const subGrep = spawned.assistant("msg_s0", [
    toolUse("toolu_sub_grep", "Grep", {pattern: "TODO"}),
  ]);
  spawned.result(subRead, "toolu_sub_read", "spec contents");
  spawned.result(subGrep, "toolu_sub_grep", "No matches");
  spawned.assistant("msg_s1", [text("Spawned answer")]);
  write(ALPHA, `${id}/subagents/agent-${spawnedId}.jsonl`, spawned.entries);
  meta(spawnedId, {
    agentType: "general-purpose",
    description: "Spawned task",
    toolUseId: "toolu_spawn",
  });

  // A fork's transcript opens with a copy of the parent thread under new uuids
  const forked = transcript(id, "/work/alpha", "2026-01-02T05:02:00Z", {
    isSidechain: true,
    agentId: forkId,
  });
  forked.user("Delegate the work", {}, null);
  const copiedSpawn = forked.assistant("msg_d1", [
    toolUse("toolu_spawn", "Agent", spawnInput),
  ]);
  forked.result(copiedSpawn, "toolu_spawn", "Spawned report");
  const copiedFork = forked.assistant("msg_d2", [
    toolUse("toolu_fork", "Agent", forkInput),
  ]);
  forked.node(
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {type: "tool_result", tool_use_id: "toolu_fork", content: "Forked"},
          text("Do the forked task"),
        ],
      },
    },
    copiedFork.uuid as string,
  );
  forked.assistant("msg_f1", [text("Fork answer")]);
  write(ALPHA, `${id}/subagents/agent-${forkId}.jsonl`, forked.entries);
  meta(forkId, {
    agentType: "fork",
    isFork: true,
    description: "Forked task",
    toolUseId: "toolu_fork",
  });

  const runDir = `subagents/workflows/${runId}`;
  const worker = transcript(id, "/work/alpha", "2026-01-02T05:03:00Z", {
    isSidechain: true,
    agentId: workflowAgentId,
  });
  worker.user("Research the fixture", {}, null);
  worker.assistant("msg_w1", [text("Workflow agent answer")]);
  write(
    ALPHA,
    `${id}/${runDir}/agent-${workflowAgentId}.jsonl`,
    worker.entries,
  );
  meta(
    workflowAgentId,
    {agentType: "researcher", workflowPhase: "Research"},
    runDir,
  );
  write(ALPHA, `${id}/${runDir}/journal.jsonl`, [
    {
      type: "started",
      key: "k1",
      agentId: workflowAgentId,
      label: "Research the fixture",
      phase: "Research",
    },
    {
      type: "result",
      key: "k1",
      agentId: workflowAgentId,
      result: "Workflow agent answer",
    },
  ]);
}

console.log(`Wrote fixtures to ${root}`);

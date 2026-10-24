import {previewToolCall, stringArgument} from "./previews.js";
import type {ThreadEntry, TranscriptEntry} from "./transcripts.js";

type EventBase = {
  /** 1-based position on the main thread, counting extras whether shown or not */
  ref: number;
  uuid: string;
  timestamp: string | null;
};

/**
 * A Workflow call's launch of a run, as its result reports it. A resumed run
 * keeps its id under a new task.
 */
export type WorkflowLaunch = {
  runId: string;
  taskId: string;
  name: string | null;
  summary: string | null;
  scriptPath: string | null;
};

export type MessageEvent = EventBase & {
  kind: "message";
  role: "user" | "assistant";
  text: string;
  /** Subagent that sent this hand-back or task notification */
  subagent?: string;
  /** Workflow launch this task notification reports on */
  workflow?: WorkflowLaunch;
};

/** The summary that continues the thread after a compaction */
export type CompactionEvent = EventBase & {
  kind: "compaction";
  text: string;
};

/** Attachment, meta, and system entries hidden unless asked for */
export type ExtraEvent = EventBase & {
  kind: "extra";
  name: string;
  text: string;
};

export type ToolEvent = EventBase & {
  kind: "tool";
  name: string;
  callId: string;
  input: Record<string, unknown>;
  result: {text: string; error: boolean} | null;
  preview: string;
  /** Subagent this call spawned or messaged */
  subagent?: string;
  /** Workflow run this call launched */
  workflow?: WorkflowLaunch;
};

export type SessionEvent =
  | MessageEvent
  | CompactionEvent
  | ExtraEvent
  | ToolEvent;

type ContentBlock = Record<string, unknown> & {type?: unknown};

/** Transcript bookkeeping fields omitted when a system entry has no content */
const ENVELOPE_FIELDS = new Set([
  "cwd",
  "entrypoint",
  "gitBranch",
  "isMeta",
  "isSidechain",
  "level",
  "logicalParentUuid",
  "parentUuid",
  "sessionId",
  "slug",
  "subtype",
  "timestamp",
  "type",
  "userType",
  "uuid",
  "version",
]);

/** Sender id or name of a subagent hand-back, or a task notification's task id */
const SENDER_PATTERN =
  /^(?:Another Claude session sent a message:\s*<agent-message from="([^"]+)"|<task-notification>\s*<task-id>([^<]+)<\/task-id>)/;

// ── Thread ────────────────────────────────────────────────────────────

/**
 * Order the thread with the off-thread entries hanging beneath each thread
 * entry (hook attachments, plugin and meta messages) spliced in after it.
 * Prompts and replies off the thread belong to abandoned branches, so they and
 * everything beneath them stay out. Every entry of a subagent transcript is a
 * sidechain entry, so only the main thread excludes them.
 */
function spliceExtras(
  entries: TranscriptEntry[],
  thread: ThreadEntry[],
): {ordered: TranscriptEntry[]; onThread: Set<string>} {
  const onThread = new Set(thread.map(({uuid}) => uuid));
  const sidechain = thread[0]?.isSidechain === true;
  const offThreadChildren = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    if (
      entry.uuid === undefined ||
      !entry.parentUuid ||
      onThread.has(entry.uuid) ||
      (entry.isSidechain === true) !== sidechain ||
      entry.type === "assistant" ||
      (entry.type === "user" && !entry.isMeta)
    ) {
      continue;
    }
    const children = offThreadChildren.get(entry.parentUuid) ?? [];
    children.push(entry);
    offThreadChildren.set(entry.parentUuid, children);
  }

  const ordered: TranscriptEntry[] = [];
  for (const threadEntry of thread) {
    ordered.push(threadEntry);
    const pending = (
      offThreadChildren.get(threadEntry.uuid) ?? []
    ).toReversed();
    while (pending.length > 0) {
      const entry = pending.pop()!;
      ordered.push(entry);
      pending.push(...(offThreadChildren.get(entry.uuid!) ?? []).toReversed());
    }
  }
  return {ordered, onThread};
}

// ── Projection ────────────────────────────────────────────────────────

/** Shared state while one thread's entries project into events */
type Projection = {
  events: SessionEvent[];
  onThread: Set<string>;
  toolsByCallId: Map<string, ToolEvent>;
  /** Spawning call id → subagent id */
  spawns: Map<string, string>;
  subagentIds: Set<string>;
  /** SendMessage may address a subagent by the name its spawning call gave it */
  subagentNames: Map<string, string>;
  launchesByTaskId: Map<string, WorkflowLaunch>;
  /** Assistant text event still accepting blocks from the same API message */
  open: {event: MessageEvent; messageId: string} | undefined;
};

type EntryBase = Omit<EventBase, "ref">;

/**
 * Project a thread into message, compaction, tool-call, and extra events,
 * numbered together so refs hold whether or not extras are shown. Claude Code
 * persists one entry per assistant content block, so consecutive text blocks
 * sharing an API message id merge into a single message event. Tool results
 * attach to their originating tool event. Spawning calls, SendMessage calls,
 * and a subagent's hand-backs and notifications all name the subagent. A
 * workflow agent has no spawning call, so only its id links it. Workflow calls
 * and their task notifications name the run launched.
 */
export function projectEvents(
  entries: TranscriptEntry[],
  thread: ThreadEntry[],
  subagents: ReadonlyArray<{id: string; toolUseId: string | null}>,
): SessionEvent[] {
  const {ordered, onThread} = spliceExtras(entries, thread);
  const state: Projection = {
    events: [],
    onThread,
    toolsByCallId: new Map(),
    spawns: new Map(
      subagents.flatMap(({id, toolUseId}) =>
        toolUseId === null ? [] : [[toolUseId, id] as const],
      ),
    ),
    subagentIds: new Set(subagents.map(({id}) => id)),
    subagentNames: new Map(),
    launchesByTaskId: new Map(),
    open: undefined,
  };

  for (const entry of ordered) {
    const base = {uuid: entry.uuid!, timestamp: entry.timestamp ?? null};
    switch (entry.type) {
      case "attachment": {
        const attachment = entry.attachment ?? {};
        const name =
          typeof attachment.type === "string" ? attachment.type : "attachment";
        pushExtra(state, base, name, attachmentText(attachment));
        break;
      }
      case "system": {
        pushExtra(state, base, entry.subtype ?? "system", systemText(entry));
        break;
      }
      case "assistant": {
        projectAssistant(state, entry, base);
        break;
      }
      case "user": {
        projectUser(state, entry, base);
        break;
      }
    }
  }
  return state.events;
}

function pushExtra(
  state: Projection,
  base: EntryBase,
  name: string,
  text: string,
): void {
  state.events.push({
    ref: state.events.length + 1,
    kind: "extra",
    name,
    text,
    ...base,
  });
}

function resolveSubagent(
  state: Projection,
  address: string | undefined,
): string | undefined {
  if (address === undefined) return;
  return (
    state.subagentNames.get(address) ??
    (state.subagentIds.has(address) ? address : undefined)
  );
}

function messageBlocks(entry: TranscriptEntry): {
  id: unknown;
  blocks: ContentBlock[];
} {
  const payload = (entry.message ?? {}) as {id?: unknown; content?: unknown};
  if (typeof payload.content === "string") {
    return {id: payload.id, blocks: [{type: "text", text: payload.content}]};
  }
  return {
    id: payload.id,
    blocks: Array.isArray(payload.content)
      ? (payload.content as ContentBlock[])
      : [],
  };
}

function projectAssistant(
  state: Projection,
  entry: TranscriptEntry,
  base: EntryBase,
): void {
  const {id, blocks} = messageBlocks(entry);
  const messageId = typeof id === "string" ? id : undefined;

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (!text) continue;
      if (state.open !== undefined && state.open.messageId === messageId) {
        state.open.event.text = `${state.open.event.text}\n\n${text}`;
        continue;
      }
      const event: MessageEvent = {
        ref: state.events.length + 1,
        kind: "message",
        role: "assistant",
        text,
        ...base,
      };
      state.events.push(event);
      state.open = messageId === undefined ? undefined : {event, messageId};
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      projectToolCall(state, block, base);
      state.open = undefined;
    } else {
      // Server tools return their result in the same assistant message
      const tool = state.toolsByCallId.get(stringField(block, "tool_use_id"));
      if (tool) tool.result = serverToolResult(block.content);
    }
  }
}

function projectToolCall(
  state: Projection,
  block: ContentBlock,
  base: EntryBase,
): void {
  const input = record(block.input);
  const name = stringField(block, "name") || "unknown";
  const tool: ToolEvent = {
    ref: state.events.length + 1,
    kind: "tool",
    name,
    preview: previewToolCall(name, input),
    callId: stringField(block, "id"),
    input,
    result: null,
    ...base,
  };
  const spawned = state.spawns.get(tool.callId);
  const subagent =
    spawned ??
    (name === "SendMessage"
      ? resolveSubagent(state, stringArgument(input, "to"))
      : undefined);
  if (subagent !== undefined) tool.subagent = subagent;
  const alias = stringArgument(input, "name");
  if (spawned !== undefined && alias !== undefined) {
    state.subagentNames.set(alias, spawned);
  }
  state.events.push(tool);
  state.toolsByCallId.set(tool.callId, tool);
}

function projectUser(
  state: Projection,
  entry: TranscriptEntry,
  base: EntryBase,
): void {
  const userText: string[] = [];
  for (const block of messageBlocks(entry).blocks) {
    if (block.type === "tool_result") {
      attachToolResult(state, entry, block);
    } else if (block.type === "text" && typeof block.text === "string") {
      userText.push(block.text);
    } else if (block.type === "image") {
      userText.push("[image]");
    }
  }
  const text = userText.join("\n").trim();
  if (!text) return;

  if (!state.onThread.has(base.uuid)) {
    const {kind} = record(entry.origin);
    pushExtra(state, base, typeof kind === "string" ? kind : "meta", text);
    return;
  }
  if (isNoise(text)) {
    pushExtra(state, base, "meta", text);
    return;
  }
  state.open = undefined;
  if (entry.isCompactSummary) {
    state.events.push({
      ref: state.events.length + 1,
      kind: "compaction",
      text,
      ...base,
    });
    return;
  }
  const message: MessageEvent = {
    ref: state.events.length + 1,
    kind: "message",
    role: "user",
    text,
    ...base,
  };
  const sender = SENDER_PATTERN.exec(text);
  const subagent = resolveSubagent(state, sender?.[1] ?? sender?.[2]);
  if (subagent !== undefined) message.subagent = subagent;
  const launch =
    sender?.[2] === undefined
      ? undefined
      : state.launchesByTaskId.get(sender[2]);
  if (launch !== undefined) message.workflow = launch;
  state.events.push(message);
}

function attachToolResult(
  state: Projection,
  entry: TranscriptEntry,
  block: ContentBlock,
): void {
  const tool = state.toolsByCallId.get(stringField(block, "tool_use_id"));
  if (!tool) return;
  tool.result = {
    text: contentText(block.content),
    error: block.is_error === true,
  };
  if (tool.name !== "Workflow") return;
  const launch = linkWorkflowLaunch(tool, record(entry.toolUseResult));
  if (launch) state.launchesByTaskId.set(launch.taskId, launch);
}

/**
 * Link a Workflow call to the run its result's `toolUseResult` names, titled by
 * the run's name and summary. A script that fails its syntax check still
 * reports a launch, with an error and no run.
 */
function linkWorkflowLaunch(
  tool: ToolEvent,
  result: Record<string, unknown>,
): WorkflowLaunch | undefined {
  if (typeof result.error === "string") {
    tool.result = {text: tool.result?.text || result.error, error: true};
    return;
  }
  const runId = stringField(result, "runId");
  const taskId = stringField(result, "taskId");
  if (!runId || !taskId) return;

  const launch: WorkflowLaunch = {
    runId,
    taskId,
    name: stringField(result, "workflowName") || null,
    summary: stringField(result, "summary") || null,
    scriptPath: stringField(result, "scriptPath") || null,
  };
  tool.workflow = launch;
  const title = [launch.name, launch.summary].filter(Boolean);
  if (title.length > 0) tool.preview = title.join(": ");
  return launch;
}

function attachmentText(attachment: Record<string, unknown>): string {
  const body =
    plainText(attachment.content) ??
    plainText(attachment.text) ??
    plainText(attachment.stdout) ??
    JSON.stringify(attachment, null, 2);
  return typeof attachment.hookName === "string"
    ? `${attachment.hookName}: ${body}`
    : body;
}

function systemText(entry: TranscriptEntry): string {
  return (
    plainText(entry.content) ??
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entry).filter(([key]) => !ENVELOPE_FIELDS.has(key)),
      ),
      null,
      2,
    )
  );
}

function plainText(value: unknown): string | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("\n").trim() || undefined;
  }
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Harness-injected user turns that carry no conversational content */
function isNoise(text: string): boolean {
  if (text.startsWith("[Request interrupted by user")) return true;
  if (
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<local-command-stderr>") ||
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("<command-name>")
  ) {
    return true;
  }
  return (
    text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>")
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string")
        return block.text;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The advisor's reply arrives encrypted unless the API returns it in plain text */
function serverToolResult(content: unknown): ToolEvent["result"] {
  const result = record(content);
  switch (result.type) {
    case "advisor_result": {
      return {text: stringField(result, "text"), error: false};
    }
    case "advisor_redacted_result": {
      return {text: "[encrypted by the server]", error: false};
    }
    case "advisor_tool_result_error": {
      return {text: stringField(result, "error_code"), error: true};
    }
  }
  return {text: contentText(content), error: false};
}

function stringField(block: ContentBlock, key: string): string {
  const value = block[key];
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

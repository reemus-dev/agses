/*
 * Session metadata and thread selection derive from the Claude Agent SDK for
 * Python (https://github.com/anthropics/claude-agent-sdk-python), adjusted to
 * match what the TypeScript SDK returns for the same transcripts.
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {createInterface} from "node:readline";

/** One JSONL transcript line; only the fields read here are typed */
export type TranscriptEntry = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  subtype?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: unknown;
  content?: unknown;
  attachment?: Record<string, unknown>;
  teamName?: string;
  origin?: {kind?: unknown};
  [key: string]: unknown;
};

/** An entry that links into the `parentUuid` chain */
export type ThreadEntry = TranscriptEntry & {uuid: string};

/** Entry types that link into the `parentUuid` chain */
const CHAIN_TYPES = new Set([
  "user",
  "assistant",
  "progress",
  "system",
  "attachment",
]);

// ─── Session metadata ─────────────────────────────────────────────────────

export type SessionMetadata = {
  /** The latest rename, else the AI title, last prompt, summary or first prompt */
  name: string;
  firstPrompt: string | null;
  /** The first recorded working directory */
  cwd: string | null;
  /** Epoch milliseconds of the first recorded timestamp */
  created: number | null;
  /** Epoch milliseconds of the transcript's last write */
  lastModified: number;
  size: number;
};

/** How much of a transcript's start and end to scan for metadata */
const SCAN_BYTES = 65_536;
const FIRST_PROMPT_LENGTH = 200;

/** Generated user text that is never a session's first prompt */
const GENERATED_PROMPT_PATTERN =
  /^(?:<local-command-stdout>|<session-start-hook>|<system-reminder>|<tick>|<goal>|\[Request interrupted by user[^\]]*\]|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/;
const COMMAND_NAME_PATTERN = /<command-name>(.*?)<\/command-name>/;
/** The tags and line breaks Claude Code wraps pasted text in */
const PASTED_CONTENT_TAGS =
  /\n{0,2}<pasted_content[^>]*>\n?|\n?<\/pasted_content[^>]*>\n{0,2}/g;
const BASH_INPUT_PATTERN = /^<bash-input>([\s\S]*)<\/bash-input>$/;

/**
 * A session's metadata from its transcript's first and last 64 KB, or null when
 * it has nothing to list: a subagent sidechain, or no name or prompt.
 */
export async function readSessionMetadata(
  transcript: string,
): Promise<SessionMetadata | null> {
  const file = Bun.file(transcript);
  const {size, mtimeMs} = await stat(transcript);
  if (size === 0) return null;
  const head = await file.slice(0, SCAN_BYTES).text();
  const tail =
    size <= SCAN_BYTES ? head : await file.slice(size - SCAN_BYTES).text();

  const [firstLine = ""] = head.split("\n", 1);
  if (/"isSidechain": ?true/.test(firstLine)) return null;

  const firstPrompt = firstPromptOf(head);
  const name =
    lastStringField(tail, "customTitle") ??
    lastStringField(head, "customTitle") ??
    lastStringField(tail, "aiTitle") ??
    lastStringField(head, "aiTitle") ??
    lastStringField(tail, "lastPrompt") ??
    lastStringField(tail, "summary") ??
    firstPrompt;
  if (!name) return null;

  const created = Date.parse(firstStringField(head, "timestamp") ?? "");
  return {
    name,
    firstPrompt,
    cwd: firstStringField(head, "cwd") ?? (await streamCwd(transcript)),
    created: Number.isNaN(created) ? null : created,
    lastModified: mtimeMs,
    size,
  };
}

/**
 * The first prompt a person wrote, on one line and cut to 200 characters, else
 * the first slash command's name
 */
function firstPromptOf(head: string): string | null {
  let command: string | undefined;
  for (const line of head.split("\n")) {
    if (
      !/"type": ?"user"/.test(line) ||
      line.includes('"tool_result"') ||
      /"isMeta": ?true/.test(line) ||
      /"isCompactSummary": ?true/.test(line)
    ) {
      continue;
    }
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type !== "user") continue;

    for (const text of userTexts(entry)) {
      const prompt = text
        .replaceAll(PASTED_CONTENT_TAGS, "")
        .replace(BASH_INPUT_PATTERN, "! $1")
        .replaceAll("\n", " ")
        .trim();
      if (!prompt) continue;
      const commandName = COMMAND_NAME_PATTERN.exec(prompt)?.[1];
      if (commandName !== undefined) {
        command ??= commandName;
        continue;
      }
      if (GENERATED_PROMPT_PATTERN.test(prompt)) continue;
      return prompt.length > FIRST_PROMPT_LENGTH
        ? `${prompt.slice(0, FIRST_PROMPT_LENGTH).trimEnd()}…`
        : prompt;
    }
  }
  return command || null;
}

function userTexts(entry: TranscriptEntry): string[] {
  const {content} = (entry.message ?? {}) as {content?: unknown};
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: Record<string, unknown> | null) =>
    block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [],
  );
}

/**
 * Every `"key":"value"` string in raw JSONL text, unescaped, in order. A cut
 * line is not JSON, so the scan reads raw text rather than parsing it.
 */
function stringFields(text: string, key: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(
    new RegExp(`"${key}": ?"((?:[^"\\\\]|\\\\.)*)"`, "g"),
  )) {
    const raw = match[1]!;
    try {
      values.push(
        raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw,
      );
    } catch {
      values.push(raw);
    }
  }
  return values;
}

function firstStringField(text: string, key: string): string | undefined {
  return stringFields(text, key)[0] || undefined;
}

function lastStringField(text: string, key: string): string | undefined {
  return stringFields(text, key).at(-1) || undefined;
}

/**
 * A transcript's first recorded cwd past the head, which a large first prompt
 * can fill
 */
async function streamCwd(transcript: string): Promise<string | null> {
  const input = createReadStream(transcript);
  try {
    for await (const line of createInterface({input})) {
      if (!line.includes('"cwd":"')) continue;
      const {cwd} = JSON.parse(line) as TranscriptEntry;
      if (typeof cwd === "string") return cwd;
    }
  } finally {
    input.destroy();
  }
  return null;
}

// ─── Threads ──────────────────────────────────────────────────────────────

/**
 * A compaction boundary starts a fresh chain (`parentUuid: null`). Re-parent
 * each boundary onto the entry written before it, so a thread runs through
 * every compaction in the order it happened.
 */
export function relinkCompactions(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  // Keyed by sidechain, so a main thread skips inline subagent entries
  const latest = new Map<boolean, string>();
  return entries.map((entry) => {
    if (entry.uuid === undefined) return entry;
    const sidechain = entry.isSidechain === true;
    const parentUuid = latest.get(sidechain);
    latest.set(sidechain, entry.uuid);
    if (
      entry.subtype !== "compact_boundary" ||
      entry.parentUuid ||
      parentUuid === undefined
    ) {
      return entry;
    }
    return {...entry, parentUuid};
  });
}

/**
 * The main thread: the latest branch's user, assistant and system entries, root
 * first. A prompt queued while the agent was busy is recorded only as an
 * attachment, so it joins the thread as a user entry under the queued command's
 * own uuid.
 */
export function mainThread(entries: TranscriptEntry[]): ThreadEntry[] {
  return conversationChain(chainEntries(entries))
    .map((entry) => queuedPrompt(entry) ?? entry)
    .filter(isMainThreadEntry);
}

/** A subagent's thread: its last message back to the root */
export function subagentThread(entries: TranscriptEntry[]): ThreadEntry[] {
  const candidates = chainEntries(entries);
  const leaf = candidates.findLast(isMessage);
  if (!leaf) return [];
  const byUuid = indexByUuid(candidates);
  return restoreParallelToolCalls(byUuid, walkBack(byUuid, leaf))
    .map((entry) => queuedPrompt(entry) ?? entry)
    .filter(isMessage);
}

function chainEntries(entries: TranscriptEntry[]): ThreadEntry[] {
  return entries.filter(
    (entry): entry is ThreadEntry =>
      CHAIN_TYPES.has(entry.type) && typeof entry.uuid === "string",
  );
}

function indexByUuid(entries: ThreadEntry[]): Map<string, ThreadEntry> {
  return new Map(entries.map((entry) => [entry.uuid, entry]));
}

function isMessage(entry: TranscriptEntry): boolean {
  return entry.type === "user" || entry.type === "assistant";
}

/** Meta entries stay off the thread, except messages from another session */
function isVisible(entry: TranscriptEntry): boolean {
  if (entry.type === "system") return true;
  if (!isMessage(entry)) return false;
  return entry.isMeta !== true || entry.origin?.kind === "peer";
}

function isMainThreadEntry(entry: TranscriptEntry): boolean {
  return entry.isSidechain !== true && !entry.teamName && isVisible(entry);
}

/** The user entry a queued command's attachment stands for */
function queuedPrompt(entry: ThreadEntry): ThreadEntry | undefined {
  const attachment = entry.attachment;
  if (
    attachment?.type !== "queued_command" ||
    typeof attachment.source_uuid !== "string"
  ) {
    return undefined;
  }
  return {
    type: "user",
    uuid: attachment.source_uuid,
    isSidechain: entry.isSidechain,
    isMeta: attachment.isMeta === true,
    origin: attachment.origin as TranscriptEntry["origin"],
    message: {role: "user", content: attachment.prompt},
  };
}

/** From `last` back to the root, returned root first */
function walkBack(
  byUuid: Map<string, ThreadEntry>,
  last: ThreadEntry,
): ThreadEntry[] {
  const chain: ThreadEntry[] = [];
  const seen = new Set<string>();
  for (
    let entry: ThreadEntry | undefined = last;
    entry !== undefined && !seen.has(entry.uuid);
    entry = entry.parentUuid ? byUuid.get(entry.parentUuid) : undefined
  ) {
    seen.add(entry.uuid);
    chain.push(entry);
  }
  return chain.toReversed();
}

/**
 * The latest main-thread branch, root first. Each terminal entry, one no other
 * entry names as its parent, ends a branch. A branch belongs to the main thread
 * when its nearest non-meta message does. The branch whose terminal comes last
 * in the file wins.
 */
function conversationChain(entries: ThreadEntry[]): ThreadEntry[] {
  const byUuid = indexByUuid(entries);
  const parents = new Set(entries.map(({parentUuid}) => parentUuid));
  const branches = entries
    .filter(({uuid}) => !parents.has(uuid))
    .flatMap((terminal) => {
      const leaf = nearestMessage(byUuid, terminal);
      return leaf ? [{terminal, leaf}] : [];
    });
  const mainBranches = branches.filter(
    ({leaf}) =>
      leaf.isSidechain !== true && !leaf.teamName && leaf.isMeta !== true,
  );
  const candidates = mainBranches.length > 0 ? mainBranches : branches;
  const latest = candidates.at(-1);
  if (latest === undefined) return [];
  return restoreParallelToolCalls(byUuid, walkBack(byUuid, latest.terminal));
}

/** The branch's nearest non-meta message, else its nearest meta message */
function nearestMessage(
  byUuid: Map<string, ThreadEntry>,
  from: ThreadEntry,
): ThreadEntry | undefined {
  let nearestMeta: ThreadEntry | undefined;
  const seen = new Set<string>();
  for (
    let entry: ThreadEntry | undefined = from;
    entry !== undefined && !seen.has(entry.uuid);
    entry = entry.parentUuid ? byUuid.get(entry.parentUuid) : undefined
  ) {
    if (isMessage(entry)) {
      if (entry.isMeta !== true) return entry;
      nearestMeta ??= entry;
    }
    seen.add(entry.uuid);
  }
  return nearestMeta;
}

// ─── Parallel tool calls ──────────────────────────────────────────────────

/**
 * Claude Code writes one assistant entry per content block, chained one after
 * another under a shared `message.id`, and parents each tool result on its own
 * call. A response with parallel tool calls therefore forks, and the walk keeps
 * only the branch the next turn continued from. Put each response's missing
 * calls and results back after its last entry on the chain, calls first, each
 * group in timestamp order.
 */
function restoreParallelToolCalls(
  byUuid: Map<string, ThreadEntry>,
  chain: ThreadEntry[],
): ThreadEntry[] {
  // The last on-chain entry of each response
  const anchors = new Map<string, ThreadEntry>();
  for (const entry of chain) {
    const messageId = assistantMessageId(entry);
    if (messageId) anchors.set(messageId, entry);
  }
  if (anchors.size === 0) return chain;

  const recovery: Recovery = {
    ...indexResponses(byUuid),
    seen: new Set(chain.map(({uuid}) => uuid)),
    answeredOnChain: new Set(chain.flatMap(answeredCallIds)),
    filePosition: new Map([...byUuid.keys()].map((uuid, i) => [uuid, i])),
  };
  const inserts = new Map<string, ThreadEntry[]>();
  for (const [messageId, anchor] of anchors) {
    const recovered = missingFromResponse(recovery, messageId, anchor);
    if (recovered.length === 0) continue;
    for (const {uuid} of recovered) recovery.seen.add(uuid);
    inserts.set(anchor.uuid, recovered);
  }

  if (inserts.size === 0) return chain;
  return chain.flatMap((entry) => [entry, ...(inserts.get(entry.uuid) ?? [])]);
}

type Responses = {
  /** Every assistant entry of each response, by message id */
  siblings: Map<string, ThreadEntry[]>;
  /** The entry that made each call; null when two responses claim its id */
  callOwner: Map<string, ThreadEntry | null>;
  /**
   * Results under each assistant entry they may belong to: their parent, their
   * source assistant entry, and the owner of a call they answer, the last two
   * only from the same writer
   */
  resultsByAssistant: Map<string, ThreadEntry[]>;
};

type Recovery = Responses & {
  /** Entries on the chain or already recovered */
  seen: Set<string>;
  answeredOnChain: Set<string>;
  filePosition: Map<string, number>;
};

function indexResponses(byUuid: Map<string, ThreadEntry>): Responses {
  const siblings = new Map<string, ThreadEntry[]>();
  const callOwner = new Map<string, ThreadEntry | null>();
  const toolResults: ThreadEntry[] = [];
  for (const entry of byUuid.values()) {
    const messageId = assistantMessageId(entry);
    if (messageId === undefined) {
      if (isToolResult(entry)) toolResults.push(entry);
      continue;
    }
    append(siblings, messageId, entry);
    for (const callId of blockIds(entry, "tool_use", "id")) {
      const owner = callOwner.get(callId);
      const sameResponse =
        owner === undefined ||
        (owner !== null && assistantMessageId(owner) === messageId);
      callOwner.set(callId, sameResponse ? entry : null);
    }
  }

  const resultsByAssistant = new Map<string, ThreadEntry[]>();
  for (const result of toolResults) {
    append(resultsByAssistant, result.parentUuid!, result);
    const source = byUuid.get(String(result.sourceToolAssistantUUID));
    if (source && sameWriter(result, source)) {
      append(resultsByAssistant, source.uuid, result);
    }
    for (const callId of answeredCallIds(result)) {
      const owner = callOwner.get(callId);
      if (owner && sameWriter(result, owner)) {
        append(resultsByAssistant, owner.uuid, result);
      }
    }
  }
  return {siblings, callOwner, resultsByAssistant};
}

/**
 * The response's entries and results the walk skipped. A result parented
 * outside the response counts only when it answers a call still unanswered.
 */
function missingFromResponse(
  recovery: Recovery,
  messageId: string,
  anchor: ThreadEntry,
): ThreadEntry[] {
  const {seen, callOwner} = recovery;
  const group = recovery.siblings.get(messageId) ?? [anchor];
  const members = new Set(group.map(({uuid}) => uuid));
  const results: ThreadEntry[] = [];
  const strays: ThreadEntry[] = [];
  const collected = new Set<string>();
  for (const member of group) {
    for (const result of recovery.resultsByAssistant.get(member.uuid) ?? []) {
      if (seen.has(result.uuid) || collected.has(result.uuid)) continue;
      collected.add(result.uuid);
      if (members.has(result.parentUuid!)) results.push(result);
      else strays.push(result);
    }
  }

  const answered = new Set(results.flatMap(answeredCallIds));
  const inFileOrder = strays.toSorted(
    (left, right) =>
      recovery.filePosition.get(left.uuid)! -
      recovery.filePosition.get(right.uuid)!,
  );
  for (const stray of inFileOrder) {
    const callIds = answeredCallIds(stray);
    const answersOpenCall = callIds.some((callId) => {
      const owner = callOwner.get(callId)?.uuid;
      return (
        !recovery.answeredOnChain.has(callId) &&
        !answered.has(callId) &&
        owner !== undefined &&
        members.has(owner)
      );
    });
    if (!answersOpenCall) continue;
    for (const callId of callIds) answered.add(callId);
    results.push(stray);
  }

  return [
    ...group.filter(({uuid}) => !seen.has(uuid)).toSorted(byTimestamp),
    ...results.toSorted(byTimestamp),
  ];
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function assistantMessageId(entry: TranscriptEntry): string | undefined {
  if (entry.type !== "assistant") return undefined;
  const {id} = (entry.message ?? {}) as {id?: unknown};
  return typeof id === "string" && id !== "" ? id : undefined;
}

function blockIds(
  entry: TranscriptEntry,
  blockType: string,
  idField: string,
): string[] {
  const {content} = (entry.message ?? {}) as {content?: unknown};
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: Record<string, unknown> | null) =>
    block?.type === blockType && typeof block[idField] === "string"
      ? [block[idField]]
      : [],
  );
}

function answeredCallIds(entry: TranscriptEntry): string[] {
  return blockIds(entry, "tool_result", "tool_use_id");
}

function isToolResult(entry: TranscriptEntry): boolean {
  return (
    entry.type === "user" &&
    Boolean(entry.parentUuid) &&
    answeredCallIds(entry).length > 0
  );
}

/** Whether two entries were written by the same agent */
function sameWriter(left: TranscriptEntry, right: TranscriptEntry): boolean {
  return (
    (left.isSidechain === true) === (right.isSidechain === true) &&
    left.agentId === right.agentId
  );
}

function byTimestamp(left: TranscriptEntry, right: TranscriptEntry): number {
  const [a, b] = [left.timestamp ?? "", right.timestamp ?? ""];
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

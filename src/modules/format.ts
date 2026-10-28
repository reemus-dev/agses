import {homedir} from "node:os";
import type {MessageEvent, SessionEvent} from "./events.js";

// ── Values ────────────────────────────────────────────────────────────

export function shortenPath(value: string): string {
  const home = homedir();
  return value === home || value.startsWith(`${home}/`)
    ? `~${value.slice(home.length)}`
    : value;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(timestamp: string | null): string {
  return timestamp?.slice(0, 10) ?? "-";
}

export function formatDateTime(timestamp: string | null): string {
  return timestamp?.slice(0, 16).replace("T", " ") ?? "-";
}

/** Milliseconds in their two largest units, such as `4m05s` or `2d03h` */
export function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  const seconds = Math.round(duration / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

/** Truncate to a terminal display width, appending "…" when cut */
function truncateToWidth(value: string, width: number, pad = false): string {
  let result = value;
  if (Bun.stringWidth(value) > width) {
    result = "";
    let used = 0;
    for (const char of value) {
      const charWidth = Bun.stringWidth(char);
      if (used + charWidth > width - 1) break;
      result += char;
      used += charWidth;
    }
    result += width > 0 ? "…" : "";
  }
  return pad
    ? result.padEnd(result.length + width - Bun.stringWidth(result))
    : result;
}

export function formatPreview(content: string, maximumWidth = 80): string {
  return truncateToWidth(content.replaceAll(/\s+/g, " ").trim(), maximumWidth);
}

// ── Tables ────────────────────────────────────────────────────────────

export function outputWidth(): number {
  if (process.stdout.columns > 0) return process.stdout.columns;

  const environmentWidth = Number(process.env.COLUMNS);
  return Number.isSafeInteger(environmentWidth) && environmentWidth > 0
    ? environmentWidth
    : 120;
}

/**
 * Column-aligned table that fits `maximumWidth`. Flexible columns shrink first,
 * in the order given, each down to its header width. Then the widest column
 * shrinks.
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  options: {flexibleColumns?: readonly number[]; maximumWidth?: number} = {},
): string {
  const maximumWidth = Math.max(1, options.maximumWidth ?? outputWidth());
  const gap = "  ";
  const widths = headers.map((header, index) =>
    Math.max(
      Bun.stringWidth(header),
      ...rows.map((row) => Bun.stringWidth(row[index] ?? "")),
    ),
  );
  const headerWidths = headers.map((header) => Bun.stringWidth(header));
  let tableWidth = gap.length * (headers.length - 1);
  for (const width of widths) tableWidth += width;

  const widest = () => {
    let column: number | undefined;
    for (const [index, width] of widths.entries()) {
      if (width <= 1) continue;
      if (column === undefined || width > widths[column]!) column = index;
    }
    return column;
  };

  while (tableWidth > maximumWidth) {
    const column =
      options.flexibleColumns?.find(
        (index) => widths[index]! > headerWidths[index]!,
      ) ?? widest();
    if (column === undefined) break;
    widths[column]!--;
    tableWidth--;
  }

  const line = (cells: string[]) =>
    cells
      .map((cell, index) => truncateToWidth(cell, widths[index]!, true))
      .join(gap)
      .trimEnd();

  return [
    line(headers),
    widths.map((width) => "-".repeat(width)).join(gap),
    ...rows.map(line),
  ].join("\n");
}

// ── Structured Output ─────────────────────────────────────────────────

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatFrontmatter(
  fields: Record<string, string | null>,
): string {
  return [
    "---",
    ...Object.entries(fields).map(
      ([name, value]) => `${name}: ${JSON.stringify(value)}`,
    ),
    "---",
  ].join("\n");
}

function serializeAttributes(
  attributes: Record<string, boolean | number | string | null>,
): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => {
      const escaped = String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `${name}="${escaped}"`;
    })
    .join(" ");
}

function formatBlock(
  tag: string,
  attributes: Record<string, boolean | number | string | null>,
  text: string,
): string {
  return `<${tag} ${serializeAttributes(attributes)}>\n${text}\n</${tag}>`;
}

export function formatMessage(
  event: MessageEvent,
  flags: Record<string, boolean> = {},
): string {
  return formatBlock(
    event.role,
    {
      entry: event.ref,
      time: event.timestamp,
      subagent: event.subagent ?? null,
      workflow: event.workflow?.runId ?? null,
      ...flags,
    },
    event.text,
  );
}

export function formatEvent(event: SessionEvent): string {
  switch (event.kind) {
    case "message": {
      return formatMessage(event);
    }
    case "compaction": {
      return formatBlock(
        "compaction",
        {entry: event.ref, time: event.timestamp},
        event.text,
      );
    }
    case "extra": {
      return formatBlock(
        "extra",
        {entry: event.ref, time: event.timestamp, name: event.name},
        event.text,
      );
    }
    case "tool": {
      const attributes = serializeAttributes({
        entry: event.ref,
        time: event.timestamp,
        name: event.name,
        subagent: event.subagent ?? null,
        workflow: event.workflow?.runId ?? null,
        error: event.result?.error === true ? true : null,
      });
      return `<tool ${attributes}>${event.preview}</tool>`;
    }
  }
}

export function formatEventDetail(event: SessionEvent): string {
  if (event.kind !== "tool") return formatEvent(event);

  const attributes = serializeAttributes({
    entry: event.ref,
    time: event.timestamp,
    name: event.name,
    callId: event.callId,
    subagent: event.subagent ?? null,
    workflow: event.workflow?.runId ?? null,
    error: event.result?.error === true ? true : null,
  });
  return [
    `<tool ${attributes}>`,
    "<input>",
    JSON.stringify(event.input, null, 2),
    "</input>",
    "<result>",
    event.result === null
      ? "(no result recorded)"
      : event.result.text || "(empty)",
    "</result>",
    "</tool>",
  ].join("\n");
}

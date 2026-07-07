import { openSync, closeSync, writeSync, readFileSync } from "node:fs";
import { transcriptPath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Types — the single source of truth for the transcript seam
// ---------------------------------------------------------------------------

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "unknown"; value: unknown };

export interface TranscriptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * On-disk transcript entry shape. Written by {@link appendTranscriptEntry} /
 * {@link appendAssistantTranscriptEntry} and read back by
 * {@link readTranscriptAfter}. One type, two ends of the seam.
 */
export interface TranscriptEntry {
  ts: string;
  role: "user" | "assistant" | "toolResult" | "unknown";
  timestamp?: number;
  content: string | TranscriptContent[];
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  usage?: TranscriptUsage;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * A simplified transcript line extracted for the reflection pipeline.
 * `index` is the absolute 0-based line index in the transcript file
 * (malformed lines are counted but carry empty text). `text` is the
 * concatenation of all `{ type: "text" }` content blocks.
 */
export interface TranscriptLine {
  /** Zero-based index in the transcript file. */
  index: number;
  role: "user" | "assistant" | "toolResult" | "unknown";
  /** Concatenated text content (text blocks joined; non-text blocks ignored). */
  text: string;
  /** ISO timestamp from the transcript entry. */
  ts: string;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function appendJsonl(path: string, entry: object): void {
  const line = JSON.stringify(entry) + "\n";
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}

function normalizeTranscriptContent(content: unknown): string | TranscriptContent[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return [{ type: "unknown", value: content }];
  return content.map((item): TranscriptContent => {
    if (typeof item !== "object" || item === null) {
      return { type: "unknown", value: item };
    }
    const block = item as Record<string, unknown>;
    switch (block.type) {
      case "text":
        return { type: "text", text: readString(block, "text") ?? "" };
      case "image":
        return { type: "image", mimeType: readString(block, "mimeType") ?? "unknown" };
      case "thinking":
        return { type: "thinking", text: readString(block, "thinking") ?? "" };
      case "toolCall":
        return {
          type: "toolCall",
          id: readString(block, "id") ?? "",
          name: readString(block, "name") ?? "",
          arguments: block.arguments,
        };
      default:
        return { type: "unknown", value: item };
    }
  });
}

/**
 * Translate a pi AgentSessionEvent into a transcript entry, or return null
 * when the event is not a `message_end` worth persisting. This is the
 * writer-side event→entry mapping; it returns the seam's shared type.
 */
function transcriptEntryFromEvent(event: object): TranscriptEntry | null {
  const e = event as Record<string, unknown>;
  if (e.type !== "message_end") return null;
  const msg = e.message;
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const roleValue = m.role;
  const role =
    roleValue === "user" || roleValue === "assistant" || roleValue === "toolResult"
      ? roleValue
      : "unknown";
  const entry: TranscriptEntry = {
    ts: readString(e, "ts") ?? new Date().toISOString(),
    role,
    timestamp: readNumber(m, "timestamp"),
    content: normalizeTranscriptContent(m.content),
  };
  if (role === "assistant") {
    entry.api = readString(m, "api");
    entry.provider = readString(m, "provider");
    entry.model = readString(m, "model");
    entry.responseModel = readString(m, "responseModel");
    entry.responseId = readString(m, "responseId");
    entry.stopReason = readString(m, "stopReason");
    entry.errorMessage = readString(m, "errorMessage");
    if (typeof m.usage === "object" && m.usage !== null) {
      const u = m.usage as Record<string, unknown>;
      entry.usage = {
        input: typeof u.input === "number" ? u.input : 0,
        output: typeof u.output === "number" ? u.output : 0,
        cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
        cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
        totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : 0,
        cost: typeof u.cost === "object" && u.cost !== null
          ? u.cost as TranscriptUsage["cost"]
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
  }
  if (role === "toolResult") {
    entry.toolCallId = readString(m, "toolCallId");
    entry.toolName = readString(m, "toolName");
    if (typeof m.isError === "boolean") entry.isError = m.isError;
  }
  return entry;
}

/**
 * Append a transcript entry derived from a pi AgentSessionEvent to the
 * session's `transcript.jsonl`. No-ops on non-`message_end` events.
 */
export function appendTranscriptEntry(sessionId: string, home: string, event: object): void {
  const entry = transcriptEntryFromEvent(event);
  if (entry === null) return;
  appendJsonl(transcriptPath(home, sessionId), entry);
}

/**
 * Append a synthetic assistant entry to the transcript for user-facing replies
 * that the intake/command layer sends directly without running an agent turn.
 * This keeps the context window honest: if the user replies to a hardcoded
 * error message, the model can see what it said.
 *
 * The entry is prefixed with a marker so the model can distinguish system
 * boilerplate from generated assistant text.
 */
export function appendAssistantTranscriptEntry(
  sessionId: string,
  home: string,
  text: string,
): void {
  const entry: TranscriptEntry = {
    ts: new Date().toISOString(),
    role: "assistant",
    content: `[system] ${text}`,
  };
  appendJsonl(transcriptPath(home, sessionId), entry);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Extract the displayable text from a transcript entry's `content`. Strings
 * pass through; arrays are reduced to the concatenation of their
 * `{ type: "text" }` blocks (thinking, tool calls, images, and unknown blocks
 * are ignored). Non-array/non-string content yields "".
 */
export function extractEntryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

/**
 * Read transcript entries with absolute line indices ≥ `processedLines`,
 * returning simplified {@link TranscriptLine} records for the reflection
 * pipeline. Returns `[]` when the transcript file does not exist yet.
 *
 * Indices are absolute across the whole file: malformed lines are counted
 * toward the cursor (an entry is emitted with role `"unknown"` and empty text)
 * so the reflection cursor's `processedLines` stays aligned regardless of
 * corruption. Entries before `processedLines` are skipped.
 */
export function readTranscriptAfter(
  home: string,
  sessionId: string,
  processedLines: number,
): TranscriptLine[] {
  const path = transcriptPath(home, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const lines = raw.split("\n");
  const result: TranscriptLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    if (i < processedLines) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      // Skip malformed lines — the cursor tracks line indices, not byte offsets,
      // so a skipped line still counts toward processedLines.
      result.push({ index: result.length + processedLines, role: "unknown", text: "", ts: new Date().toISOString() });
      continue;
    }
    const role = entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult"
      ? entry.role
      : "unknown";
    result.push({
      index: result.length + processedLines,
      role,
      text: extractEntryText(entry.content),
      ts: entry.ts ?? new Date().toISOString(),
    });
  }
  return result;
}

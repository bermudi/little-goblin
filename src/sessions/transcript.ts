import { openSync, closeSync, writeSync, readFileSync, writeFileSync } from "node:fs";
import { parseSurfaceId, surfaceId, type SurfaceId } from "../surface.ts";
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
  /** Canonical SurfaceId for user-visible entries produced by a Surface-backed runtime. */
  sourceSurfaceId?: SurfaceId;
}

/**
 * Explicit writer context for every transcript append. Surface-backed writes
 * carry the runtime capture's canonical SurfaceId; internal writes explicitly
 * omit it. The context is required so omission is deliberate, not accidental.
 */
export type TranscriptWriterContext =
  | { kind: "surface"; sourceSurfaceId: SurfaceId }
  | { kind: "internal" };

/**
 * A simplified transcript line extracted for the reflection pipeline.
 * `index` is the absolute 0-based logical line index in the transcript
 * file (one per non-blank line; blank lines are not counted, malformed
 * lines are counted but carry empty text). `text` is the concatenation
 * of all `{ type: "text" }` content blocks.
 */
export interface TranscriptLine {
  /** Zero-based logical line index (non-blank lines only). */
  index: number;
  role: "user" | "assistant" | "toolResult" | "unknown";
  /** Concatenated text content (text blocks joined; non-text blocks ignored). */
  text: string;
  /** ISO timestamp from the transcript entry. */
  ts: string;
  /** Validated source Surface provenance when available. */
  sourceSurfaceId?: SurfaceId;
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

function readCost(value: unknown): TranscriptUsage["cost"] {
  if (typeof value !== "object" || value === null) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  const c = value as Record<string, unknown>;
  return {
    input: typeof c.input === "number" ? c.input : 0,
    output: typeof c.output === "number" ? c.output : 0,
    cacheRead: typeof c.cacheRead === "number" ? c.cacheRead : 0,
    cacheWrite: typeof c.cacheWrite === "number" ? c.cacheWrite : 0,
    total: typeof c.total === "number" ? c.total : 0,
  };
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

function validateSurfaceId(id: SurfaceId): void {
  // parseSurfaceId throws for non-canonical, unknown-version, or malformed
  // SurfaceIds. This is the only place the transcript module validates the
  // canonical codec; all other code receives already-validated SurfaceIds.
  parseSurfaceId(id);
}

function readNormalizedSourceSurfaceId(raw: unknown): SurfaceId | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const surface = parseSurfaceId(raw);
    return surfaceId(surface);
  } catch {
    return undefined;
  }
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
        cost: readCost(u.cost),
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
 *
 * The writer context is required: Surface-backed appends stamp the entry with
 * the runtime capture's canonical `sourceSurfaceId`; internal appends omit it.
 */
export function appendTranscriptEntry(
  sessionId: string,
  home: string,
  event: object,
  ctx: TranscriptWriterContext,
): void {
  const entry = transcriptEntryFromEvent(event);
  if (entry === null) return;
  if (ctx.kind === "surface") {
    validateSurfaceId(ctx.sourceSurfaceId);
    entry.sourceSurfaceId = ctx.sourceSurfaceId;
  }
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
  ctx: TranscriptWriterContext,
): void {
  const entry: TranscriptEntry = {
    ts: new Date().toISOString(),
    role: "assistant",
    content: `[system] ${text}`,
  };
  if (ctx.kind === "surface") {
    validateSurfaceId(ctx.sourceSurfaceId);
    entry.sourceSurfaceId = ctx.sourceSurfaceId;
  }
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
  const raw = extractEntryTextRaw(content);
  // Strip control characters that indicate binary content (e.g. ZIP headers
  // from file-read tool results). Keep \n \r \t; replace everything else in
  // the C0 control range with a space so the text is at least searchable.
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
}

function extractEntryTextRaw(content: unknown): string {
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

function parseTranscriptEntry(value: unknown): TranscriptEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;

  const rawRole = m.role;
  const role =
    rawRole === "user" || rawRole === "assistant" || rawRole === "toolResult" || rawRole === "unknown"
      ? rawRole
      : null;
  if (role === null) return null;

  const ts = readString(m, "ts") ?? new Date().toISOString();
  const timestamp = readNumber(m, "timestamp");
  const content = normalizeTranscriptContent(m.content);
  const sourceSurfaceId = readNormalizedSourceSurfaceId(m.sourceSurfaceId);

  const entry: TranscriptEntry = { ts, role, timestamp, content, sourceSurfaceId };
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
        cost: readCost(u.cost),
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

export interface IndexedTranscriptEntry {
  lineIndex: number;
  entry: TranscriptEntry | null;
}

/**
 * A lossless raw transcript line plus its normalized entry, exposed only for
 * the offline provenance migrator. Ordinary readers must use the normalized
 * typed interfaces; this shape preserves the original JSON text so rewrites
 * can leave unchanged records byte-for-byte.
 */
export interface TranscriptRawLine {
  /** Zero-based logical line index (non-blank lines only). */
  lineIndex: number;
  /** Original JSONL text for this line, used for byte-preserving rewrites. */
  line: string;
  /** Parsed raw object when the line is valid JSON; otherwise null. */
  raw: Record<string, unknown> | null;
  /** Normalized typed entry when the raw object is a recognized transcript entry. */
  entry: TranscriptEntry | null;
}

function readTranscriptRawLinesInternal(path: string): TranscriptRawLine[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const lines = raw.split("\n");
  const result: TranscriptRawLine[] = [];
  let lineIndex = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const index = lineIndex;
    lineIndex++;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const rawObj = parsed as Record<string, unknown>;
        const entry = parseTranscriptEntry(rawObj);
        result.push({ lineIndex: index, line, raw: rawObj, entry });
        continue;
      }
    } catch {
      // malformed line — counted but null
    }
    result.push({ lineIndex: index, line, raw: null, entry: null });
  }
  return result;
}

/**
 * Read all transcript entries, pairing each non-blank line with its logical
 * line index. Malformed lines are counted toward the logical index but return
 * a null entry so callers can match the reflection cursor. This is the single
 * typing authority for parsing transcript JSONL.
 */
export function readTranscriptEntries(home: string, sessionId: string): IndexedTranscriptEntry[] {
  const path = transcriptPath(home, sessionId);
  return readTranscriptRawLinesInternal(path).map(({ lineIndex, entry }) => ({
    lineIndex,
    entry,
  }));
}

export function countTranscriptLines(home: string, sessionId: string): number {
  return readTranscriptEntries(home, sessionId).length;
}

/**
 * Read transcript entries with logical line indices ≥ `processedLines`,
 * returning simplified {@link TranscriptLine} records for the reflection
 * pipeline. Returns `[]` when the transcript file does not exist yet.
 *
 * Indices are logical (non-blank) line counts, matching how the reflection
 * cursor seeds and advances `processedLines`: malformed lines are counted
 * toward the cursor (an entry is emitted with role `"unknown"` and empty
 * text) so the cursor stays aligned regardless of corruption; blank lines
 * are skipped and do NOT advance the logical index. Entries before
 * `processedLines` are skipped.
 */
export function readTranscriptAfter(
  home: string,
  sessionId: string,
  processedLines: number,
): TranscriptLine[] {
  const result: TranscriptLine[] = [];
  for (const { lineIndex, entry } of readTranscriptEntries(home, sessionId)) {
    if (lineIndex < processedLines) continue;
    if (entry === null) {
      result.push({
        index: lineIndex,
        role: "unknown",
        text: "",
        ts: new Date().toISOString(),
      });
      continue;
    }
    const role = entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult"
      ? entry.role
      : "unknown";
    result.push({
      index: lineIndex,
      role,
      text: extractEntryText(entry.content),
      ts: entry.ts ?? new Date().toISOString(),
      sourceSurfaceId: entry.sourceSurfaceId,
    });
  }
  return result;
}

/**
 * Migration-only raw-record reader. Returns every non-blank JSONL line with
 * its original text, parsed raw object, and normalized entry. The `line`
 * field preserves the original bytes so rewrites can leave unchanged records
 * untouched. This operation is exported only for `TranscriptProvenanceMigrator`;
 * ordinary readers, indexers, dreaming, commands, and intake must not use it.
 */
export function readTranscriptRawLines(home: string, sessionId: string): TranscriptRawLine[] {
  return readTranscriptRawLinesInternal(transcriptPath(home, sessionId));
}

/**
 * Migration-only raw-record writer. Replaces the transcript file with the
 * supplied lines. Callers (the offline migrator) are responsible for atomic
 * tmp/rename replacement and precomputing all candidate rewrites.
 */
export function writeTranscriptRawLines(home: string, sessionId: string, lines: TranscriptRawLine[]): void {
  const path = transcriptPath(home, sessionId);
  const text = lines.map((l) => l.line).join("\n") + (lines.length > 0 ? "\n" : "");
  writeFileSync(path, text, "utf-8");
}

const DEFAULT_MAX_CHUNK_CHARS = 500;

export interface TranscriptChunk {
  text: string;
  ts: string;
  role: TranscriptEntry["role"];
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  /** Validated source Surface provenance when the source entry carried one. */
  sourceSurfaceId?: SurfaceId;
}

function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      const words = sentence.split(/\s+/);
      let piece = "";
      for (const word of words) {
        if (word.length > maxChars) {
          if (piece.length > 0) {
            chunks.push(piece.trim());
            piece = "";
          }
          for (let i = 0; i < word.length; i += maxChars) {
            chunks.push(word.slice(i, i + maxChars));
          }
          continue;
        }
        if (piece.length + word.length + 1 > maxChars && piece.length > 0) {
          chunks.push(piece.trim());
          piece = "";
        }
        piece = piece.length === 0 ? word : `${piece} ${word}`;
      }
      if (piece.length > 0) chunks.push(piece.trim());
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current = current.length === 0 ? sentence : `${current} ${sentence}`;
  }
  if (current.length > 0) chunks.push(current.trim());
  return chunks;
}

/**
 * Chunk a transcript entry into bounded snippets (max 500 chars by default).
 * Returns snippets that include the entry's timestamp, role, and session ID.
 * Skips tool-result entries with no displayable text and entries shorter than
 * 8 displayable characters.
 */
export function chunkTranscriptEntry(
  entry: TranscriptEntry,
  opts: { sessionId: string; maxChars?: number },
): TranscriptChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const text = extractEntryText(entry.content).trim();
  if (text.replace(/\s/g, "").length < 8) return [];

  const ts = entry.ts ?? new Date().toISOString();
  const role = entry.role ?? "unknown";
  const prefix = `[${ts}] [${role}] [${opts.sessionId}] `;
  const effectivePrefix = prefix.length >= maxChars ? "" : prefix;
  const available = Math.max(1, maxChars - effectivePrefix.length);
  const rawChunks = chunkText(text, available);

  const baseTime = (() => {
    if (typeof entry.timestamp === "number") return entry.timestamp * 1000;
    const parsedTs = new Date(ts).getTime();
    return Number.isFinite(parsedTs) ? parsedTs : Date.now();
  })();
  return rawChunks.map((chunk) => ({
    text: `${effectivePrefix}${chunk}`,
    ts,
    role,
    sessionId: opts.sessionId,
    createdAt: baseTime,
    updatedAt: baseTime,
    sourceSurfaceId: entry.sourceSurfaceId,
  }));
}

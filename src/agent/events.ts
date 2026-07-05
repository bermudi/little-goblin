import { openSync, closeSync, writeSync } from "node:fs";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { transcriptPath } from "../sessions/paths.ts";

/** Callbacks for turn events */
export interface TurnCallbacks {
  onTextDelta: (text: string) => void;
  onToolStart: (name: string, input: unknown) => void;
  onToolEnd: (name: string, isError: boolean) => void;
  onStatusUpdate: (message: string) => void;
  onAgentEnd: () => void;
}

type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "unknown"; value: unknown };

interface TranscriptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface TranscriptEntry {
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
 * Translate a single pi AgentSessionEvent into typed callback invocations.
 *
 * Covers the event types runners consume; ignores all others.
 * Pure function — no side effects beyond callback invocations.
 */
export function dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void {
  switch (event.type) {
    case "agent_start":
      // Fires once at the top of every turn (pi-agent-core runAgentLoop),
      // before any model call. This is the turn-start cue for the
      // "🤔 thinking…" placeholder + typing indicator — covering plain-text
      // turns where the model emits no thinking block and no tools. Without
      // it, those turns show neither feedback until the first text token.
      callbacks.onStatusUpdate("thinking...");
      break;

    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        callbacks.onTextDelta(ame.delta);
      } else if (
        ame.type === "thinking_start" ||
        ame.type === "thinking_delta"
      ) {
        callbacks.onStatusUpdate("thinking...");
      }
      break;
    }

    case "tool_execution_start":
      callbacks.onToolStart(event.toolName, event.args);
      break;

    case "tool_execution_end":
      callbacks.onToolEnd(event.toolName, event.isError === true);
      break;

    case "agent_end":
      callbacks.onAgentEnd();
      break;

    case "compaction_start":
      callbacks.onStatusUpdate("🗜 compacting…");
      break;

    case "compaction_end": {
      const tokensBefore = readCompactionTokensBefore(event);
      const tokens = tokensBefore === undefined ? "unknown" : `~${Math.round(tokensBefore / 1000)}k`;
      callbacks.onStatusUpdate(`compacted from ${tokens} tokens`);
      break;
    }

    case "message_end": {
      // Surface assistant-side errors (bad API key, rate limit, aborted, etc.)
      // as visible text. Without this the user is stuck on "🤔 thinking…"
      // forever because no text_delta ever arrives and no tools observed
      // means buildStatusLine returns "" on the done transition.
      const msg = (event as { message?: unknown }).message;
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { role?: unknown }).role === "assistant"
      ) {
        const am = msg as { stopReason?: unknown; errorMessage?: unknown };
        if (
          (am.stopReason === "error" || am.stopReason === "aborted") &&
          typeof am.errorMessage === "string" &&
          am.errorMessage.length > 0
        ) {
          const label = am.stopReason === "aborted" ? "aborted" : "error";
          callbacks.onTextDelta(`\n\n❌ ${label}: ${am.errorMessage}`);
        }
      }
      break;
    }

    // Ignore all other event types
  }
}

/**
 * Extract the concatenated assistant text from a `message_end` event's
 * `message.content`. Joins every `{ type: "text" }` block in order; ignores
 * thinking, tool calls, images, and unknown blocks. Returns `undefined` when
 * the event is not an assistant message_end with text content.
 *
 * Used by the runner to reconcile streamed deltas against the final assembled
 * message — see `handleEvent` in `mod.ts`.
 */
export function extractAssistantText(event: object): string | undefined {
  const e = event as Record<string, unknown>;
  if (e.type !== "message_end") return undefined;
  const msg = e.message;
  if (typeof msg !== "object" || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  if (m.role !== "assistant") return undefined;
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text.length > 0 ? text : undefined;
}

function readCompactionTokensBefore(event: AgentSessionEvent): number | undefined {
  const result = (event as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const tokensBefore = (result as { tokensBefore?: unknown }).tokensBefore;
  return typeof tokensBefore === "number" ? tokensBefore : undefined;
}

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

export function appendTranscriptEntry(sessionId: string, home: string, event: object): void {
  const entry = transcriptEntryFromEvent(event);
  if (entry === null) return;
  appendJsonl(transcriptPath(home, sessionId), entry);
}

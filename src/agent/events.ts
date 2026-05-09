import { openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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

interface TranscriptEntry {
  ts: string;
  role: "user" | "assistant" | "toolResult" | "unknown";
  timestamp?: number;
  content: string | TranscriptContent[];
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Translate a single pi AgentSessionEvent into typed callback invocations.
 *
 * Covers the five event types both runners consume; ignores all others.
 * Pure function — no side effects beyond callback invocations.
 */
export function dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void {
  switch (event.type) {
    case "agent_start":
      callbacks.onStatusUpdate("thinking...");
      break;

    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        callbacks.onTextDelta(ame.delta);
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
 * Strip accumulated snapshots from streaming events before persisting.
 *
 * `message_update` carries both `message` (full current message) and
 * `assistantMessageEvent.partial` (accumulated assistant snapshot). Both
 * grow with every delta, turning events.jsonl into an O(n²) log. We keep
 * the delta itself and drop the snapshots; the final message is already
 * captured by `message_end`.
 */
function normalizeForLog(event: object): object {
  if (
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>).type === "message_update"
  ) {
    const e = event as Record<string, unknown>;
    const ame = e.assistantMessageEvent;
    if (typeof ame === "object" && ame !== null) {
      const slimAme: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ame)) {
        if (k !== "partial") slimAme[k] = v;
      }
      const slimEvent: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e)) {
        if (k !== "message") slimEvent[k] = v;
      }
      slimEvent.assistantMessageEvent = slimAme;
      return slimEvent;
    }
  }
  return event;
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
    entry.stopReason = readString(m, "stopReason");
    entry.errorMessage = readString(m, "errorMessage");
  }
  if (role === "toolResult") {
    entry.toolCallId = readString(m, "toolCallId");
    entry.toolName = readString(m, "toolName");
    if (typeof m.isError === "boolean") entry.isError = m.isError;
  }
  return entry;
}

/**
 * Append an event to the session's events.jsonl file.
 *
 * - Opens with O_APPEND for atomic line-level appends
 * - Stamps every event with `ts: <ISO-8601>` if not already present
 * - Uses single writeSync call for atomic per-line append
 * - Normalizes `message_update` events to strip accumulated snapshots
 *
 * @param sessionId - The session ID
 * @param home - GOBLIN_HOME path
 * @param event - The event object to append
 */
export function appendEvent(sessionId: string, home: string, event: object): void {
  const normalized = normalizeForLog(event);
  const eventWithTs = "ts" in normalized ? normalized : { ...normalized, ts: new Date().toISOString() };
  const eventsFile = join(home, "sessions", sessionId, "events.jsonl");
  appendJsonl(eventsFile, eventWithTs);
}

export function appendTranscriptEntry(sessionId: string, home: string, event: object): void {
  const entry = transcriptEntryFromEvent(event);
  if (entry === null) return;
  appendJsonl(join(home, "sessions", sessionId, "transcript.jsonl"), entry);
}

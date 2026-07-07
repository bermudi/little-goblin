import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// The transcript seam — type, writer, reader — lives in sessions/transcript.ts.
// events.ts re-exports the writers it still owns (turn-event translation) so
// existing import sites (`agent/mod.ts`, `tg/intake.ts`) are unaffected.
export { appendTranscriptEntry, appendAssistantTranscriptEntry } from "../sessions/transcript.ts";

/** Callbacks for turn events */
export interface TurnCallbacks {
  onTextDelta: (text: string) => void;
  onToolStart: (name: string, input: unknown) => void;
  onToolEnd: (name: string, isError: boolean) => void;
  onStatusUpdate: (message: string) => void;
  onAgentEnd: () => void;
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

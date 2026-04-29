import { openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

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

    // Ignore all other event types
  }
}

/**
 * Append an event to the session's events.jsonl file.
 *
 * - Opens with O_APPEND for atomic line-level appends
 * - Stamps every event with `ts: <ISO-8601>` if not already present
 * - Uses single writeSync call for atomic per-line append
 *
 * @param sessionId - The session ID
 * @param home - GOBLIN_HOME path
 * @param event - The event object to append
 */
export function appendEvent(sessionId: string, home: string, event: object): void {
  const eventWithTs = "ts" in event ? event : { ...event, ts: new Date().toISOString() };
  const line = JSON.stringify(eventWithTs) + "\n";

  const eventsFile = join(home, "sessions", sessionId, "events.jsonl");
  const fd = openSync(eventsFile, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

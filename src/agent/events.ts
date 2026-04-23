import { openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";

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

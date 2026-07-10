import { join } from "node:path";

/**
 * Pure path utilities for the goblin filesystem layout.
 */

/**
 * A goblin-generated session id is 10 chars of lowercase hex (0-9a-f). This is
 * the shape produced by `makeSessionId` in `src/sessions/manager.ts`. It is used
 * as a defense-in-depth check for the new `heartbeatMdPathForSession` surface.
 */
const SESSION_ID_HEX_RE = /^[0-9a-f]{10}$/;

/**
 * Reject session ids that could escape `state/sessions/` via path traversal.
 * Goblin session ids are generated and never user input, but this guard keeps
 * path helpers safe if a bad value ever reaches them. This is a single shared
 * validation function used by all session-id-based path helpers.
 */
function validateSessionId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid session id: must be a non-empty string`);
  }
  if (id === "." || id === "..") {
    throw new Error(`Invalid session id: cannot be "." or ".."`);
  }
  if (id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid session id: cannot contain path separators`);
  }
  for (const segment of id.split("/")) {
    if (segment === "..") {
      throw new Error(`Invalid session id: cannot contain ".." segments`);
    }
  }
}

export function sessionsDir(home: string): string {
  return join(home, "state", "sessions");
}

export function sessionDir(home: string, id: string): string {
  validateSessionId(id);
  return join(sessionsDir(home), id);
}

export function statePath(home: string, id: string): string {
  return join(sessionDir(home, id), "state.json");
}

export function transcriptPath(home: string, id: string): string {
  return join(sessionDir(home, id), "transcript.jsonl");
}

export function configPath(home: string): string {
  return join(home, "state", "bindings.json");
}

export function topicSettingsPath(home: string): string {
  return join(home, "state", "topic-settings.json");
}

export function schedulesPath(home: string): string {
  return join(home, "state", "schedules.json");
}

/**
 * Path to a session-scoped `HEARTBEAT.md` prompt file. The id is validated as
 * goblin-generated lowercase hex (defense-in-depth) in addition to the shared
 * path-traversal guard in `sessionDir`.
 */
export function heartbeatMdPathForSession(home: string, id: string): string {
  validateSessionId(id);
  if (!SESSION_ID_HEX_RE.test(id)) {
    throw new Error(`Invalid session id: must be 10 lowercase hex characters`);
  }
  return join(sessionDir(home, id), "HEARTBEAT.md");
}

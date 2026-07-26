import { join } from "node:path";

/**
 * Pure path utilities for the goblin filesystem layout.
 */

/**
 * Validate a session directory name. This is a filesystem-safety guard, not a
 * format check: conversation ids must still be 10-char lowercase hex, which is
 * enforced by `validateConversationId` at conversation boundaries. Internal
 * session names (e.g. `__goblin_dreaming__`) are safe directory names but not
 * hex, so this helper allows them.
 */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function validateSessionId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid session id: must be a non-empty string`);
  }
  if (!SAFE_SESSION_ID_RE.test(id)) {
    throw new Error(`Invalid session id: must contain only alphanumeric characters, underscores, or hyphens`);
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

export function metricsPath(home: string, id: string): string {
  return join(sessionDir(home, id), "metrics.jsonl");
}

export function piSessionDir(home: string, id: string): string {
  validateSessionId(id);
  return join(sessionDir(home, id), "pi");
}

export function configPath(home: string): string {
  return join(home, "state", "bindings.json");
}

export function topicSettingsPath(home: string): string {
  return join(home, "state", "topic-settings.json");
}

export function pendingProjectAssignmentPath(home: string): string {
  return join(home, "state", "pending-project-assignment.json");
}

export function schedulesPath(home: string): string {
  return join(home, "state", "schedules.json");
}

/**
 * Path to a session-scoped `HEARTBEAT.md` prompt file. The id is validated as
 * a safe directory name by the shared `validateSessionId`.
 */
export function heartbeatMdPathForSession(home: string, id: string): string {
  validateSessionId(id);
  return join(sessionDir(home, id), "HEARTBEAT.md");
}

export function memoryDreamingCursorPath(home: string, id: string): string {
  validateSessionId(id);
  return join(sessionDir(home, id), "memory-dreaming-cursor.json");
}

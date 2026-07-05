import { join } from "node:path";

/**
 * Pure path utilities for the goblin filesystem layout.
 */

export function sessionsDir(home: string): string {
  return join(home, "state", "sessions");
}

export function sessionDir(home: string, id: string): string {
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

import { join } from "node:path";

/**
 * Pure path utilities for the goblin filesystem layout.
 */

export function sessionsDir(home: string): string {
  return join(home, "sessions");
}

export function sessionDir(home: string, id: string): string {
  return join(sessionsDir(home), id);
}

export function workdir(home: string, id: string): string {
  return join(sessionDir(home, id), "workdir");
}

export function statePath(home: string, id: string): string {
  return join(sessionDir(home, id), "state.json");
}

export function eventsPath(home: string, id: string): string {
  return join(sessionDir(home, id), "events.jsonl");
}

export function transcriptPath(home: string, id: string): string {
  return join(sessionDir(home, id), "transcript.jsonl");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

import { join } from "node:path";

export function delegatedWorkRoot(home: string): string {
  return join(home, "state", "delegated-work");
}

export function delegatedWorkRunsRoot(home: string): string {
  return join(delegatedWorkRoot(home), "runs");
}

export function delegatedWorkRunDir(home: string, id: string): string {
  return join(delegatedWorkRunsRoot(home), id);
}

export function delegatedWorkRecordPath(home: string, id: string): string {
  return join(delegatedWorkRunDir(home, id), "record.json");
}

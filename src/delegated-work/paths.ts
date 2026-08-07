import { join } from "node:path";

export const SAFE_RUN_ID_RE = /^[A-Za-z0-9_-]+$(?![\s\S])/;

function validateRunId(id: string): void {
  if (!SAFE_RUN_ID_RE.test(id)) {
    throw new Error(
      `Invalid delegated work run id ${JSON.stringify(id)}: must be a non-empty single safe path segment`,
    );
  }
}

export function delegatedWorkRoot(home: string): string {
  return join(home, "state", "delegated-work");
}

export function delegatedWorkRunsRoot(home: string): string {
  return join(delegatedWorkRoot(home), "runs");
}

export function delegatedWorkRunDir(home: string, id: string): string {
  validateRunId(id);
  return join(delegatedWorkRunsRoot(home), id);
}

export function delegatedWorkRecordPath(home: string, id: string): string {
  validateRunId(id);
  return join(delegatedWorkRunDir(home, id), "record.json");
}

import { dirname, isAbsolute, join, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { TerminalStatuses as TerminalStatusArray, type ExternalAgentEvent, type ExternalAgentStatus, type TerminalStatus } from "./types.ts";

export const TerminalStatuses: ReadonlySet<TerminalStatus> = new Set(TerminalStatusArray);

export function isTerminal(status: ExternalAgentStatus): status is TerminalStatus {
  return TerminalStatuses.has(status as TerminalStatus);
}

export function isTerminalEventType(type: ExternalAgentEvent["type"]): type is TerminalStatus {
  return TerminalStatuses.has(type as TerminalStatus);
}

export function errorString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function nowIso(clock?: () => number): string {
  return new Date((clock ?? Date.now)()).toISOString();
}

export function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

export function isPathWithinProject(path: string, projectDir: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(projectDir)) {
    return false;
  }

  let projectReal: string;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    return false;
  }
  if (projectReal.length > 1 && projectReal.endsWith(sep)) {
    projectReal = projectReal.slice(0, -1);
  }

  // Resolve the path one component at a time, following symlinks for existing
  // components and treating .. relative to the resolved (real) path. This avoids
  // path traversal via symlinks followed by .. (e.g. project/link/../secret).
  let resolved: string = sep;
  const parts = path.split(sep).filter((p) => p.length > 0 && p !== ".");

  for (const part of parts) {
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }

    const current = join(resolved, part);

    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // The component does not exist yet (e.g. a new file). It is safe to
        // continue as long as the parent path resolved within the project.
        resolved = current;
        continue;
      }
      return false;
    }

    if (stat.isSymbolicLink()) {
      try {
        resolved = realpathSync(current);
      } catch {
        // Broken or otherwise unresolvable symlink: fail closed.
        return false;
      }
    } else {
      resolved = current;
    }
  }

  if (resolved.length > 1 && resolved.endsWith(sep)) {
    resolved = resolved.slice(0, -1);
  }

  if (resolved === projectReal) return true;
  if (projectReal === sep) return resolved.startsWith(sep);
  return resolved.startsWith(projectReal + sep);
}

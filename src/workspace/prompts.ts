/**
 * WorkspacePrompts — the deployment prompt-file authority.
 *
 * Owns the catalog of Goblin prompt files, their required/optional read
 * policy, the heartbeat first-non-empty-wins resolution chain, and startup
 * preflight. Path construction stays in the path-helper modules (decision
 * 0008); this module is the sole source-code reader of prompt files
 * (decision 0009, amended by 0050), including the Surface-scoped
 * `state/surfaces/<SurfaceId>/HEARTBEAT.md`. Agent-runtime rewrites during
 * user-facing turns are governed by decision 0039, not this module.
 *
 * Read policy (fail loud): ENOENT on a required file throws
 * `MissingSoulError`; ENOENT on an optional file yields absent (`null`);
 * every non-ENOENT error propagates unwrapped.
 */

import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import { surfaceId, type Surface } from "../surface.ts";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "./paths.ts";

export class MissingSoulError extends Error {
  readonly code = "GOBLIN_MISSING_SOUL";
  readonly path: string;

  constructor(path: string) {
    super(
      `Missing required Goblin prompt file: ${path}. Run onboarding or create SOUL.md in $GOBLIN_HOME/workspace/.`,
    );
    this.name = "MissingSoulError";
    this.path = path;
  }
}

export type WorkspacePromptFileName = "SOUL.md" | "AGENTS.md" | "HEARTBEAT.md";
export type WorkspacePromptFileRequirement = "required" | "optional";

export interface WorkspacePromptFile {
  readonly name: WorkspacePromptFileName;
  readonly requirement: WorkspacePromptFileRequirement;
  readonly path: string;
  /** Operator-facing hint preflight emits when this optional file is absent. */
  readonly missingNote?: string;
}

/** The deployment prompt-file catalog: SOUL.md required; AGENTS.md and HEARTBEAT.md optional. */
export function workspacePromptCatalog(home: string): readonly WorkspacePromptFile[] {
  return [
    { name: "SOUL.md", requirement: "required", path: soulMdPath(home) },
    {
      name: "AGENTS.md",
      requirement: "optional",
      path: agentsMdPath(home),
      missingNote: "Create AGENTS.md in $GOBLIN_HOME/workspace/ for agent operating rules.",
    },
    { name: "HEARTBEAT.md", requirement: "optional", path: heartbeatMdPath(home) },
  ];
}

/** Look up one catalog entry by name. Throws on a name outside the catalog. */
export function workspacePromptFile(
  home: string,
  name: WorkspacePromptFileName,
): WorkspacePromptFile {
  const file = workspacePromptCatalog(home).find((entry) => entry.name === name);
  if (file === undefined) {
    throw new Error(`Unknown workspace prompt file: ${name}`);
  }
  return file;
}

/**
 * Required-file read policy: ENOENT throws `MissingSoulError`; every other
 * error propagates unwrapped.
 */
export async function readRequiredPromptFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isEnoent(err)) throw new MissingSoulError(path);
    throw err;
  }
}

/**
 * Optional-file read policy: ENOENT yields absent (`null`); every other
 * error propagates unwrapped.
 */
export async function readOptionalPromptFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export interface PreflightWorkspacePromptFilesOptions {
  home: string;
  warn: (message: string, extra?: unknown) => void;
}

/**
 * Startup preflight over the catalog: a missing required file throws
 * `MissingSoulError`; a missing optional file warns only when its catalog
 * entry carries a `missingNote`. Non-ENOENT check failures propagate.
 */
export async function preflightWorkspacePromptFiles(
  opts: PreflightWorkspacePromptFilesOptions,
): Promise<void> {
  for (const file of workspacePromptCatalog(opts.home)) {
    try {
      await access(file.path);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      if (file.requirement === "required") throw new MissingSoulError(file.path);
      if (file.missingNote !== undefined) {
        opts.warn("optional Goblin prompt file missing", {
          path: file.path,
          note: file.missingNote,
        });
      }
    }
  }
}

/**
 * The system-owned heartbeat prompt. The `[heartbeat]` prefix makes the prompt
 * distinguishable from user-authored text at the agent layer and in
 * transcripts. The body MUST NOT claim a user asked a new question.
 *
 * Pinned here (not constructed dynamically) so drift cannot quietly violate
 * the "MUST NOT claim a user asked a new question" rule.
 */
export const HEARTBEAT_PROMPT =
  "[heartbeat] This is a scheduled self-check-in. No user message prompted this turn. Review the current conversation context and decide whether there is anything useful, timely, or important to say. If there is nothing worth saying, reply briefly that you have nothing to add and stop.";

/**
 * Read a candidate heartbeat prompt file and return its content if it exists
 * and is non-whitespace. Returns `null` for ENOENT or whitespace-only files.
 * Non-ENOENT read errors propagate.
 */
function readHeartbeatCandidate(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
  if (raw.trim().length === 0) return null;
  return raw.trimEnd();
}

function stripLeadingHeartbeat(body: string): string {
  return body.replace(/^\[heartbeat\]\s*/, "");
}

/**
 * Resolve the heartbeat prompt body for a given Surface.
 *
 * Checks candidates in first-non-empty-wins order:
 * 1. `$GOBLIN_HOME/state/surfaces/<SurfaceId>/HEARTBEAT.md`
 * 2. `$GOBLIN_HOME/workspace/HEARTBEAT.md`
 * 3. The system-owned `HEARTBEAT_PROMPT` constant
 *
 * When a file yields non-whitespace content, its content is used as the prompt
 * body with the `[heartbeat] ` prefix prepended (the file holds the user-
 * authored body; the system owns the prefix). When a file is absent or
 * empty/whitespace-only, the next candidate is tried. The constant already
 * includes the `[heartbeat]` prefix, so no double-prefixing occurs on the
 * fallback path. Non-ENOENT read errors propagate (fail loud, per AGENTS.md).
 *
 * Whitespace contract: leading whitespace is preserved (the user may intend it
 * as part of the body, e.g. an indented first line); only trailing whitespace
 * is stripped. The emptiness check uses `trim()` so a file of only whitespace
 * falls back to the next candidate.
 */
export function resolveHeartbeatPrompt(home: string, surface: Surface): string {
  const surfaceBody = readHeartbeatCandidate(surfaceHeartbeatPath(home, surfaceId(surface)));
  if (surfaceBody !== null) return `[heartbeat] ${stripLeadingHeartbeat(surfaceBody)}`;
  const globalBody = readHeartbeatCandidate(heartbeatMdPath(home));
  if (globalBody !== null) return `[heartbeat] ${stripLeadingHeartbeat(globalBody)}`;
  return HEARTBEAT_PROMPT;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

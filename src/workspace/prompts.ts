/**
 * WorkspacePrompts — the deployment prompt-file authority.
 *
 * Owns the catalog of Goblin prompt files, their required/optional read
 * policy, the heartbeat first-non-empty-wins resolution chain, startup
 * preflight, presence inspection, the reserved-file and deployment-file
 * set projections, and create-missing materialization from templates.
 * Path construction stays in the path-helper modules (decision
 * 0008); this module is the sole source-code reader of deployment
 * prompt files (decision 0009, amended by 0050), including the
 * Surface-scoped `state/surfaces/<SurfaceId>/HEARTBEAT.md`. Named-agent
 * persona files are subagent-owned and stay with `named-agents.ts`;
 * onboarding's existence probes stay with `onboard.ts`. Agent-runtime
 * rewrites during user-facing turns are governed by decision 0039,
 * not this module.
 *
 * Read policy (fail loud): ENOENT on a required file throws
 * `MissingSoulError`; ENOENT on an optional file yields absent (`null`);
 * every non-ENOENT error propagates unwrapped.
 */

import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

/**
 * Read one catalog file with its declared policy: a required file throws
 * `MissingSoulError` on ENOENT; an optional file yields `null`. Callers
 * dispatch on the catalog's `requirement` rather than re-selecting read
 * policy per file name, so reclassifying a file in the catalog changes
 * its read policy everywhere.
 */
export async function readPromptFile(
  file: WorkspacePromptFile,
): Promise<string | null> {
  return file.requirement === "required"
    ? readRequiredPromptFile(file.path)
    : readOptionalPromptFile(file.path);
}

export interface PreflightWorkspacePromptFilesOptions {
  home: string;
  warn: (message: string, extra?: unknown) => void;
}

/**
 * Startup preflight over the catalog: a missing required file throws
 * `MissingSoulError`; a missing optional file warns only when its catalog
 * entry carries a `missingNote`. Optional files without a `missingNote`
 * have no preflight policy (decision 0010) and are not inspected at all.
 * A file that is present but not a readable regular file — a directory or
 * other non-regular file, or a file failing the readability probe — fails
 * preflight rather than surfacing later during prompt processing; other
 * inspection errors (e.g. stat failures) propagate unwrapped.
 */
export async function preflightWorkspacePromptFiles(
  opts: PreflightWorkspacePromptFilesOptions,
): Promise<void> {
  for (const file of workspacePromptCatalog(opts.home)) {
    if (file.requirement !== "required" && file.missingNote === undefined) {
      continue;
    }
    const presence = inspectPromptFile(file.path);
    // A failed readability probe means the file exists and is a regular
    // file but cannot be read: a determined present-but-unusable state,
    // not an inspection failure.
    const unreadable = presence.kind === "error" && presence.operation === "read";
    if (presence.kind === "error" && !unreadable) throw presence.error;
    // A dangling symlink resolves to ENOENT on every downstream read, so
    // preflight treats it as absent even though lstat can see the link.
    const absent =
      presence.kind === "missing" ||
      (presence.kind === "not-regular" && presence.danglingSymlink);
    if (absent) {
      if (file.requirement === "required") throw new MissingSoulError(file.path);
      opts.warn("optional Goblin prompt file missing", {
        path: file.path,
        note: file.missingNote,
      });
    } else if (presence.kind === "not-regular" || unreadable) {
      throw new Error(
        `Goblin prompt file ${file.name} is not a regular readable file: ${file.path}`,
      );
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
  // Leading indentation before the marker is preserved (leading whitespace
  // belongs to the body); only the marker and its following whitespace go.
  return body.replace(/^([^\S\n]*)\[heartbeat\]\s*/, "$1");
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

/**
 * Result of probing a prompt file's presence. Only ENOENT counts as
 * "missing"; every other failure is retained as an error so callers surface
 * the underlying problem instead of misreporting the file as absent. A
 * `not-regular` presence carries `danglingSymlink`: stat resolves the link
 * to ENOENT (so reads downstream behave exactly like a missing file) while
 * lstat still sees the link itself. Presence reporters keep it a critical
 * not-regular diagnostic; absence-policy callers treat it as missing.
 */
export type PromptFilePresence =
  | { kind: "regular" }
  | { kind: "missing" }
  | { kind: "not-regular"; danglingSymlink: boolean }
  | { kind: "error"; operation: "stat" | "read"; error: unknown };

/** Resolved absolute paths of every deployment prompt file in the catalog. */
export function deploymentPromptFilePaths(home: string): Set<string> {
  return new Set(workspacePromptCatalog(home).map((file) => resolve(file.path)));
}

/**
 * The write-notice reserved set: every deployment prompt file plus the bound
 * Surface's scoped `HEARTBEAT.md` when a Surface is bound.
 */
export function reservedPromptFilePaths(home: string, surface?: Surface): Set<string> {
  const paths = deploymentPromptFilePaths(home);
  if (surface !== undefined) {
    paths.add(resolve(surfaceHeartbeatPath(home, surfaceId(surface))));
  }
  return paths;
}

/**
 * Inspect a prompt file's presence without collapsing bad filesystem states
 * into absence. A dangling symlink is not a true ENOENT: lstat can still see
 * the link, so it is reported as non-regular with `danglingSymlink` set
 * rather than as missing — callers decide whether the link counts as absent.
 */
export function inspectPromptFile(path: string): PromptFilePresence {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (err) {
    if (!isEnoent(err)) {
      return { kind: "error", operation: "stat", error: err };
    }
    try {
      lstatSync(path);
      return { kind: "not-regular", danglingSymlink: true };
    } catch (lstatErr) {
      if (isEnoent(lstatErr)) return { kind: "missing" };
      return { kind: "error", operation: "stat", error: lstatErr };
    }
  }
  if (!isFile) {
    return { kind: "not-regular", danglingSymlink: false };
  }
  try {
    accessSync(path, constants.R_OK);
    return { kind: "regular" };
  } catch (err) {
    if (isEnoent(err)) return { kind: "missing" };
    return { kind: "error", operation: "read", error: err };
  }
}

export function buildSoulTemplate(agentName: string): string {
  return `# ${agentName}

${agentName} is the agent-owned conversational identity for this Little Goblin.

## Voice

- Be concise, direct, and useful in Telegram conversations.
- Preserve the operator's preferences and house style here.
- Keep private identity and relationship details in this file, not in source code.
`;
}

export const DEFAULT_AGENTS_TEMPLATE = `# Operating Rules

- Treat Telegram as the primary interface.
- Be truthful about tool use, uncertainty, and state changes.
- Ask before destructive or irreversible actions.
- Keep durable preferences and deployment-specific rules in this file.
`;

export interface MaterializePromptFilesResult {
  readonly createdSoul: boolean;
  readonly createdAgents: boolean;
  /** True when AGENTS.md already existed without SOUL.md; the caller warns. */
  readonly agentsWithoutSoul: boolean;
}

/**
 * Create-missing materialization (decision 0039's onboarding ruling):
 * `SOUL.md` and `AGENTS.md` are created from templates with exclusive `wx`
 * creation and never overwritten; parent directories are ensured.
 * `HEARTBEAT.md` is never materialized — it is optional and has a built-in
 * fallback. The AGENTS-without-SOUL condition is reported to the caller via
 * `agentsWithoutSoul` rather than warned about here; operator-facing output
 * stays with the caller.
 */
export function materializePromptFiles(home: string, agentName: string): MaterializePromptFilesResult {
  const soulPath = soulMdPath(home);
  const agentsPath = agentsMdPath(home);
  const hasSoul = existsSync(soulPath);
  const hasAgents = existsSync(agentsPath);
  const agentsWithoutSoul = !hasSoul && hasAgents;

  let createdSoul = false;
  let createdAgents = false;
  mkdirSync(home, { recursive: true });
  // SOUL.md and AGENTS.md live under workspace/; ensure that parent exists
  // before the writeFileSync calls (home alone is not enough on a fresh tree).
  mkdirSync(dirname(soulPath), { recursive: true });
  if (!hasSoul) {
    writeFileSync(soulPath, buildSoulTemplate(agentName), { flag: "wx" });
    createdSoul = true;
  }
  if (!hasAgents) {
    writeFileSync(agentsPath, DEFAULT_AGENTS_TEMPLATE, { flag: "wx" });
    createdAgents = true;
  }

  return { createdSoul, createdAgents, agentsWithoutSoul };
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

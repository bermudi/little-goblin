/**
 * Type definitions for the subagent runtime.
 *
 * See specs/changes/subagent-runtime/specs/subagents/spec.md for behavior.
 * Phase 1: skeleton — implementations land in subsequent phases.
 */

/** Status of a subagent instance. */
export type SubagentStatus = "running" | "idle" | "completed" | "cancelled" | "error";

/** Role of a subagent. Generic = inherits parent skills; named = isolated. */
export type SubagentRole = "generic" | "named";

/**
 * Options accepted by `SubagentRunner.spawn()`.
 */
export interface SpawnOptions {
  /** The user-message-style prompt sent to the subagent on its first turn. */
  prompt: string;
  /**
   * Optional named-agent identifier. When set, the runner loads
   * `~/goblin/agents/<name>/AGENTS.md` and isolates skills.
   */
  name?: string;
  /**
   * Current depth in the spawn tree. Goblin (root) = 0, its subagents = 1, etc.
   * Defaults to 0 when omitted (i.e. spawned by goblin).
   */
  depth?: number;
  /**
   * Optional callback for streaming subagent activity back to the caller.
   * The runner prefixes status messages with the subagent name/id.
   */
  onStatusUpdate?: (message: string) => void;
}

/**
 * Handle returned by `spawn()` while the subagent is running or queued.
 * The result string is filled in once the subagent completes.
 */
export interface SubagentHandle {
  id: string;
  status: SubagentStatus;
}

/**
 * Lightweight metadata exposed by `list()`.
 */
export interface SubagentInfo {
  id: string;
  name: string | null;
  role: SubagentRole;
  status: SubagentStatus;
  spawnedAt: string;
}

/**
 * Internal in-memory representation of an active subagent.
 * Concrete shape (session ref, callbacks, abort handles) is filled in
 * during phases 2+; kept open here so tests can assert basic identity.
 */
export interface SubagentInstance {
  id: string;
  name: string | null;
  role: SubagentRole;
  status: SubagentStatus;
  depth: number;
  spawnedAt: string;
  /** Absolute path to the directory holding `session.jsonl` and `meta.json`. */
  dir: string;
}

/**
 * Definition of a named agent loaded from `~/goblin/agents/<name>/`.
 */
export interface NamedAgentDefinition {
  name: string;
  /** Absolute path to the agent's root directory. */
  dir: string;
  /** Contents of `AGENTS.md` — used as the system prompt. */
  agentsMd: string;
  /** Absolute path to the agent's `skills/` directory (may not exist on disk yet). */
  skillsDir: string;
}

/** Maximum subagent recursion depth. */
export const MAX_SUBAGENT_DEPTH = 3;

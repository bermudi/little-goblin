/**
 * Type definitions for the subagent runtime.
 *
 * See specs/changes/subagent-runtime/specs/subagents/spec.md for behavior.
 */

import type { SessionManager } from "@mariozechner/pi-coding-agent";

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
   * Depth of the *spawner* in the subagent tree. Goblin (root) is 0,
   * a subagent goblin spawned is at depth 1, and so on. The runner
   * computes the new subagent's depth as `spawner.depth + 1`.
   * Defaults to 0 (i.e. spawned directly by goblin).
   */
  depth?: number;
  /** Identifier of the spawning agent (goblin session id or parent subagent id). */
  spawnedBy?: string;
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
 * The pi `AgentSession` reference is attached in phase 4 when execution lands.
 */
export interface SubagentInstance {
  id: string;
  name: string | null;
  role: SubagentRole;
  status: SubagentStatus;
  /** Depth of *this* subagent (spawner.depth + 1). */
  depth: number;
  spawnedAt: string;
  spawnedBy: string | null;
  /** Absolute path to the directory holding `session.jsonl` and `meta.json`. */
  dir: string;
  /** The pi SessionManager owning the persisted session for this subagent. */
  sessionManager: SessionManager;
  /** Initial prompt — kept around so phase 4 can hand it to AgentSession. */
  initialPrompt: string;
  /** Optional status callback registered by the spawner. */
  onStatusUpdate?: (message: string) => void;
}

/**
 * On-disk metadata for a subagent (`meta.json`).
 */
export interface SubagentMeta {
  id: string;
  role: SubagentRole;
  name: string | null;
  spawnedBy: string | null;
  depth: number;
  createdAt: string;
  /** Set in phase 4 once execution finishes. */
  completedAt?: string;
  /** Set in phase 4/6 to track lifecycle. */
  status?: SubagentStatus;
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

/**
 * Type definitions for the subagent runtime.
 *
 * See specs/changes/subagent-runtime/specs/subagents/spec.md for behavior.
 */

import type { AgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

/** Status of a subagent instance. */
export type SubagentStatus = "running" | "completed" | "cancelled" | "error";

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

  /**
   * Maximum wall-clock time (ms) the subagent may run before being
   * considered timed out. Defaults to 10 minutes (600 000 ms).
   *
   * The timeout is enforced at the tool-handler layer (Promise.race).
   * On timeout the subagent is cancelled and a timeout error is
   * returned to the LLM.
   */
  timeoutMs?: number;
}

/**
 * Handle returned by `spawn()` while the subagent is running or queued.
 *
 * `status` reflects the subagent's state at the moment `spawn()` returned —
 * always `"running"` for a fresh spawn. The terminal state is observable
 * via `result`: it resolves with the subagent's final assistant text on
 * `agent_end`, or rejects with the underlying error on failure / abort.
 *
 * Callers (the `spawn_subagent` tool, future revival flows) should
 * `await handle.result` to obtain the response and let exceptions
 * propagate as tool errors.
 */
export interface SubagentHandle {
  id: string;
  status: SubagentStatus;
  result: Promise<string>;
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
 *
 * `status` is mutated as the lifecycle advances:
 *   running → completed | error | cancelled
 *
 * `session`, `unsubscribe`, and `result` are populated by phase 4's
 * execution wiring once the AgentSession kicks off.
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
  /** Absolute path to `meta.json` for this subagent. */
  metaPath: string;
  /** The pi SessionManager owning the persisted session for this subagent. */
  sessionManager: SessionManager;
  /** Initial prompt — handed to the AgentSession on the first turn. */
  initialPrompt: string;
  /** Optional status callback registered by the spawner. */
  onStatusUpdate?: (message: string) => void;
  /**
   * Loaded definition for named agents. `null` for generic subagents.
   * Phase 4 reads `agentsMd` to build the system prompt and uses
   * `skillsDir` to override pi's resource loader for strict isolation.
   */
  definition: NamedAgentDefinition | null;
  /** AgentSession created when execution starts. */
  session: AgentSession | null;
  /** Tear-down for the AgentSession event subscription. */
  unsubscribe: (() => void) | null;
  /** Resolves with the subagent's final assistant text on `agent_end`. */
  result: Promise<string>;
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
  /** Set when execution finishes (success, error, or cancellation). */
  completedAt?: string;
  /** Lifecycle status — mutated as the subagent transitions states. */
  status?: SubagentStatus;
  /** Populated when status is `"error"`. */
  errorMessage?: string;
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

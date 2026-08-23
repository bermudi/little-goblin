/**
 * Type definitions for the subagent runtime.
 *
 * Historical design: `specs/changes/archive/2026-04-26-subagent-runtime/`.
 */

import type { ResolvedSkillSet } from "../agent/skills/mod.ts";
import type { SurfaceMemoryAuthority, CapturedMemoryContext, SurfaceMemoryCaller } from "../memory/mod.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type {
  AttachedDelegatedWorkOwnership,
  AttachedWorkRegistration,
  DelegatedDeliveryState,
  DelegatedRuntimeContext,
} from "../delegated-work/mod.ts";
import type { SubagentExecution } from "./host.ts";

/** Status of a subagent instance. */
export type SubagentStatus = "running" | "completed" | "cancelled" | "error";

/** Role of a subagent. Generic = inherits parent skills; named = isolated. */
export type SubagentRole = "generic" | "named";

/**
 * Invocation-lifetime authority inherited by a generic subagent.
 *
 * The spawning or reviving runtime is authoritative for both values. Keeping
 * them together prevents an environment-selected manifest from being run
 * under an unrelated CWD. Recursive generic children receive this same
 * immutable bundle; named agents use their definition directory instead.
 */
export interface GenericSubagentInheritance {
  readonly executionEnvironment: ExecutionEnvironment;
  readonly resolvedSkills: ResolvedSkillSet;
}

/**
 * Options shared by every `SubagentRunner.spawn()` call.
 */
interface SpawnOptionsBase {
  /** The user-message-style prompt sent to the subagent on its first turn. */
  prompt: string;
  /**
   * Surface memory authority inherited from the spawning agent. Contains the
   * canonical source SurfaceId and projected ActiveScope; persona identity is
   * derived separately from the child role.
   */
  authority: SurfaceMemoryAuthority;
  /**
   * Depth of the *spawner* in the subagent tree. Goblin (root) is 0,
   * a subagent goblin spawned is at depth 1, and so on. The runner
   * computes the new subagent's depth as `spawner.depth + 1`.
   * Defaults to 0 (i.e. spawned directly by goblin).
   */
  depth?: number;
  /** Identifier of the spawning agent (legacy root session id or parent subagent id). */
  spawnedBy?: string;
  /** Trusted runtime authority supplied by the current Conversation runtime. */
  delegatedContext?: DelegatedRuntimeContext;
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
 * Spawn a generic subagent. The parent runtime's immutable Execution
 * Environment and frozen manifest are mandatory: the child runs under that
 * CWD, receives exactly those selected files, and never re-runs discovery.
 */
export interface GenericSpawnOptions extends SpawnOptionsBase {
  name?: undefined;
  /** Frozen environment and skill authority inherited from the spawning runtime. */
  inheritance: GenericSubagentInheritance;
}

/**
 * Spawn a named agent. The runner loads
 * `$GOBLIN_HOME/workspace/agents/<name>/AGENTS.md`
 * and isolates skills to the agent's own catalog; the caller's manifest is
 * not inherited.
 */
export interface NamedSpawnOptions extends SpawnOptionsBase {
  /** Named-agent identifier (e.g. 'researcher'). */
  name: string;
}

/**
 * Options accepted by `SubagentRunner.spawn()`.
 */
export type SpawnOptions = GenericSpawnOptions | NamedSpawnOptions;

/**
 * Handle returned by `spawn()` while the subagent is running or queued.
 *
 * `status` reflects the subagent's state at the moment `spawn()` returned —
 * always `"running"` for a fresh spawn. The terminal state is observable
 * via `result`: it resolves with the subagent's final assistant text when
 * Pi reaches `agent_settled`, or rejects with the underlying error on failure / abort.
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
 * Exact persisted history target — either create a new session directory or open an existing session file.
 */
export type SubagentHistoryTarget =
  | {
      readonly kind: "create";
      readonly sessionDir: string;
    }
  | {
      readonly kind: "open";
      readonly sessionDir: string;
      readonly sessionFile: string;
    };

/**
 * Lightweight metadata exposed by `list()`.
 */
export interface SubagentInfo {
  id: string;
  name: string | null;
  role: SubagentRole;
  status: SubagentStatus;
  spawnedAt: string;
  /** Captured delegated ownership; absent only on legacy compatibility records. */
  ownerConversationId?: string;
  runtimeId?: string;
  lifetime?: "attached";
  originSurfaceId?: string;
  executionEnvironment?: ExecutionEnvironment;
  ownershipEpochId?: string;
  deliveryState?: DelegatedDeliveryState;
  /**
   * Identifier of the spawning agent — goblin session id for top-level
   * subagents, or parent subagent id for nested ones. `null` for
   * subagents whose meta predates this field.
   */
  spawnedBy: string | null;
}

/**
 * Internal in-memory representation of an active subagent.
 *
 * `status` is mutated as the lifecycle advances:
 *   running → completed | error | cancelled
 *
 * `execution` is populated by the coordinator once the invocation plan is
 * ready. Pi session objects never escape the host lease.
 */
export interface SubagentInstance {
  id: string;
  name: string | null;
  role: SubagentRole;
  status: SubagentStatus;
  /**
   * Surface memory authority inherited from the spawning agent. The source
   * SurfaceId and projected ActiveScope are frozen for this invocation.
   */
  authority: SurfaceMemoryAuthority;
  /** Caller descriptor derived from the child role (anonymous or named). */
  caller: SurfaceMemoryCaller;
  /** Completed invocation capture, set once execution starts. */
  capture?: CapturedMemoryContext;
  /** Depth of *this* subagent (spawner.depth + 1). */
  depth: number;
  spawnedAt: string;
  spawnedBy: string | null;
  /** Absolute path to the run directory holding `record.json` and session files. */
  dir: string;
  /** Index of the current invocation in the record's append-only log. */
  invocationIndex: number;
  /** Exact new/open history target selected by the coordinator. */
  history: SubagentHistoryTarget;
  /** Initial prompt — handed to the opaque Pi execution lease. */
  initialPrompt: string;
  /** Optional status callback registered by the spawner (already prefixed). */
  onStatusUpdate?: (message: string) => void;
  /**
   * Raw (unprefixed) callback for nested subagent spawning.
   * Prevents prefix stacking when a subagent spawns another subagent.
   */
  rawStatusCallback?: (message: string) => void;
  /**
   * Loaded definition for named agents. `null` for generic subagents.
   * Phase 4 reads `agentsMd` to build the system prompt and uses
   * `skillsDir` to override pi's resource loader for strict isolation.
   */
  definition: NamedAgentDefinition | null;
  /**
   * Frozen environment and skill authority inherited from the spawning or
   * reviving runtime. Set for generic subagents; `null` for named agents,
   * which use their definition directory and isolated catalog.
   */
  inheritance: GenericSubagentInheritance | null;
  /** Opaque invocation-lifetime Pi lease created by the host. */
  execution: SubagentExecution | null;
  /** Immutable delegated ownership for the current invocation, when attached. */
  delegatedOwnership: AttachedDelegatedWorkOwnership | null;
  /** Registration with DelegatedWorkHost, held until terminal cleanup. */
  delegatedRegistration: AttachedWorkRegistration | null;
  /** True after runtime invalidation fences this invocation epoch. */
  runtimeFenced: boolean;
  /** Terminal execution outcome and delivery are separate pieces of state. */
  deliveryState: DelegatedDeliveryState;
  /** Ephemeral host success reservation; never persisted as authority. */
  completionClaimed: boolean;
  /** Coordinator settlement, distinct from the immediately cancellable result. */
  settlement: Promise<void>;
  resolveSettlement: () => void;
  rejectSettlement: (error: unknown) => void;
  /** Shared idempotent stop operation across startup and cancellation races. */
  stopPromise: Promise<void> | null;
  /** Shared outcome of an accepted explicit cancellation and all concurrent callers. */
  cancellationPromise: Promise<void> | null;
  /** Whether coordinator execution/cleanup has been launched for this lease. */
  settlementStarted: boolean;
  /** Resolves with the subagent's final assistant text after Pi reaches `agent_settled`. */
  result: Promise<string>;
  /** Resolves/rejects `result`. Stored on the instance so cancellation paths
   * can settle the handle when the agent session cannot. */
  resolveResult: (text: string) => void;
  /** Rejects `result`. Stored on the instance for cancellation paths. */
  rejectResult: (err: unknown) => void;
}

/**
 * Definition of a named agent loaded from
 * `$GOBLIN_HOME/workspace/agents/<name>/`.
 */
export interface NamedAgentDefinition {
  name: string;
  /** Absolute path to the agent's root directory. */
  dir: string;
  /** Contents of `AGENTS.md` — used as the system prompt. */
  agentsMd: string;
  /** Absolute path to the agent's `.agents/skills/` catalog (may not exist yet). */
  skillsDir: string;
}

/** Maximum subagent recursion depth. */
export const MAX_SUBAGENT_DEPTH = 3;

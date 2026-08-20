/**
 * `SubagentRunner` — lifecycle orchestrator for subagents spawned by goblin
 * (or by another subagent).
 *
 * Owns:
 *   - the in-memory map of active instances (keyed by id)
 *   - the deployment-lifetime execution host reference
 *   - concurrency guards (disposed flag, in-flight revive set)
 *   - the public surface: `spawn`, `revive`, `cancel`, `list`, `dispose`
 *
 * Does NOT own (delegated to siblings):
 *   - persistence → `meta.ts`
 *   - named-agent definition loading → `named-agents.ts`
 *   - Pi resource mechanics → `host.ts`
 *   - the run-to-completion coordinator → `execution.ts`
 *
 * Current behavior is exercised by `mod.test.ts` and `test/*.suite.ts`.
 * Historical design: `specs/changes/archive/2026-04-26-subagent-runtime/`.
 */

import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { boundedError, log } from "../log.ts";
import {
  DelegatedWorkHost,
  type AttachedDelegatedWorkOwnership,
  type AttachedWorkAdapter,
  type DelegatedRuntimeContext,
  type DelegatedWorkKind,
  type DelegatedWorkRecord,
} from "../delegated-work/mod.ts";
import {
  MemoryStore,
  EmbeddingProvider,
  type CapturedMemoryContext,
  type SurfaceMemoryCaller,
} from "../memory/mod.ts";
import {
  PiSubagentHost,
  SubagentExecutionStoppedError,
  waitWithTimeout,
  type SubagentExecution,
  type SubagentHost,
  type SubagentInvocation,
  type SubagentPreparation,
} from "./host.ts";
import { environmentCwd, environmentsEqual, personalEnvironment } from "../sessions/environment.ts";
import { topicScopeDir } from "../memory/paths.ts";
import {
  type ExecutionDeps,
  markErrored,
  prefixStatusCallback,
  runInstance,
  teardownInstance,
} from "./execution.ts";
import { findSessionFile } from "./meta.ts";
import { loadNamedAgent, NamedAgentNotFoundError } from "./named-agents.ts";
import { VALID_NAME_RE } from "./validation.ts";
import { namedAgentDir } from "./paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type GenericSubagentInheritance,
  type NamedAgentDefinition,
  type SpawnOptions,
  type SubagentHandle,
  type SubagentInfo,
  type SubagentInstance,
  type SubagentRole,
  type SubagentStatus,
} from "./types.ts";

/**
 * Factory that produces tools to inject into spawned subagents.
 *
 * `inheritance` is the frozen environment and skill authority this subagent
 * received: recursive generic spawns pass it on unchanged; it is `null` for
 * named agents.
 */
export type SubagentToolFactory = (
  runner: SubagentRunner,
  depth: number,
  sessionId: string,
  parentCapture: CapturedMemoryContext,
  inheritance: GenericSubagentInheritance | null,
  onStatusUpdate?: (message: string) => void,
  delegatedContext?: DelegatedRuntimeContext,
  parentSubagentId?: string,
) => SubagentInvocation["customTools"];

export type SubagentMemoryStoreFactory = (
  home: string,
  embeddingProvider?: EmbeddingProvider,
) => MemoryStore;

/** Expected user-facing refusal to start a revived invocation. */
export class SubagentReviveRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentReviveRejectedError";
  }
}

/** Expected contention refusal while another invocation owns the subagent. */
export class SubagentReviveBusyError extends Error {
  readonly subagentId: string;

  constructor(subagentId: string, message: string) {
    super(message);
    this.name = "SubagentReviveBusyError";
    this.subagentId = subagentId;
  }
}

/** Thrown when a completed subagent delivery is rejected by runtime invalidation. */
export class RuntimeFenceError extends Error {
  readonly subagentId: string;
  constructor(subagentId: string) {
    super(`Subagent '${subagentId}' delivery was suppressed by runtime invalidation`);
    this.name = "RuntimeFenceError";
    this.subagentId = subagentId;
  }
}

function genericExecutionCwd(
  inheritance: GenericSubagentInheritance | null,
  home: string,
): string {
  if (inheritance === null) {
    throw new Error("generic subagent requires inherited execution authority");
  }
  return environmentCwd(inheritance.executionEnvironment, home);
}

function sameDelegatedRuntimeContext(
  a: DelegatedRuntimeContext,
  b: DelegatedRuntimeContext,
): boolean {
  if (a.ownerConversationId !== b.ownerConversationId) return false;
  if (a.runtimeId !== b.runtimeId) return false;
  if (a.originSurfaceId !== b.originSurfaceId) return false;
  if (a.executionEnvironment.kind !== b.executionEnvironment.kind) return false;
  if (a.executionEnvironment.kind === "personal") return true;
  if (b.executionEnvironment.kind !== "project") return false;
  return a.executionEnvironment.projectRoot === b.executionEnvironment.projectRoot;
}

function preparationFor(
  cwd: string,
  history: SubagentInstance["history"],
  role: SubagentRole,
  definition: NamedAgentDefinition | null,
  inheritance: GenericSubagentInheritance | null,
): SubagentPreparation {
  if (role === "named") {
    if (definition === null) throw new Error("Named subagent is missing its loaded definition");
    return {
      cwd,
      history,
      resource: { kind: "named", skillsDir: definition.skillsDir },
    };
  }
  if (inheritance === null) {
    throw new Error("Generic subagent requires inherited execution and skill authority");
  }
  const capturedSkills = inheritance.resolvedSkills.skills
    .filter((skill) => skill.snapshot !== undefined)
    .map((skill) => {
      const snapshot = skill.snapshot;
      if (snapshot === undefined) {
        throw new Error("captured generic skill snapshot disappeared during preparation");
      }
      return { ...skill, snapshot };
    });
  const allSkillsCaptured = capturedSkills.length === inheritance.resolvedSkills.skills.length;
  return {
    cwd,
    history,
    resource: {
      kind: "generic",
      skillPaths: allSkillsCaptured
        ? []
        : inheritance.resolvedSkills.skills.map((skill) => skill.filePath),
      ...(allSkillsCaptured && capturedSkills.length > 0
        ? {
            skillSnapshots: capturedSkills.map((skill) => ({
              name: skill.name,
              snapshot: skill.snapshot,
            })),
          }
        : {}),
    },
  };
}

async function stopPreparedExecution(execution: SubagentExecution, id: string): Promise<void> {
  try {
    await execution.stop();
  } catch (err) {
    log.error("prepared subagent execution cleanup failed", { id, ...boundedError(err) });
    throw err;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function combineFailures(failures: readonly unknown[], message: string): Error | null {
  if (failures.length === 0) return null;
  if (failures.length === 1) {
    const failure = failures[0];
    return failure instanceof Error ? failure : new Error(String(failure));
  }
  return new AggregateError(failures, message);
}

/**
 * Bounds the wait for a completion-claimed subagent's final result during
 * cancellation/disposal. The Pi completion cleanup path
 * (`finishTerminalSuccess` → `cleanup(false)` → `session.dispose()`) has no
 * internal timeout protection (unlike the abort path), so an unbounded
 * `await instance.result` could block the parent agent or the entire session.
 * Mirrors the host's default quiescence timeout magnitude.
 */
const CANCEL_COMPLETION_TIMEOUT_MS = 10_000;

function stopInstanceExecution(instance: SubagentInstance): Promise<void> | null {
  if (instance.stopPromise !== null) return instance.stopPromise;
  const execution = instance.execution;
  if (execution === null) return null;
  instance.execution = null;
  let stopPromise: Promise<void>;
  try {
    stopPromise = execution.stop();
  } catch (error) {
    stopPromise = Promise.reject(error);
  }
  instance.stopPromise = stopPromise;
  stopPromise.catch(() => {});
  return stopPromise;
}

async function collectSettlement(
  instance: SubagentInstance,
  failures: unknown[],
): Promise<void> {
  try {
    await instance.settlement;
  } catch (error) {
    // A stopped execution is the expected consequence of cancellation. Any
    // other rejection is coordinator cleanup that the caller must see.
    if (!(error instanceof SubagentExecutionStoppedError)) failures.push(error);
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function assertTopicDirectory(home: string, id: string, chatId: number, topicId: number): void {
  const path = topicScopeDir(home, chatId, topicId);
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error(
        `Subagent '${id}' topic scope (${chatId}/${topicId}) is not a directory; cannot revive`,
      );
    }
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new Error(
        `Subagent '${id}' topic scope (${chatId}/${topicId}) no longer exists; cannot revive`,
      );
    }
    throw err;
  }
}

/**
 * Manages all subagents spawned within a goblin process.
 */
export class SubagentRunner {
  private readonly cfg: Config;
  /** Goblin home directory — exposed for dynamic tool descriptions. */
  readonly goblinHome: string;
  private readonly activeSubagents: Map<string, SubagentInstance> = new Map();
  private host: SubagentHost | null;
  /** Produces tools (e.g. spawn_subagent) injected into each spawned subagent. */
  private readonly toolFactory: SubagentToolFactory | null;
  /** Shared embedding provider for memory stores created per subagent run. */
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly memoryStoreFactory: SubagentMemoryStoreFactory;
  /** Prevents new spawns after dispose(). */
  private disposed = false;
  /** Guards against concurrent revive() of the same subagent ID. */
  private readonly revivesInProgress: Set<string> = new Set();
  /** Deduplicates epoch-wide cancellation when several child registrations race. */
  private readonly attachedCancellationPromises = new Map<string, Promise<void>>();
  /** Deduplicates epoch-wide quiescence checks across child registrations. */
  private readonly attachedQuiescencePromises = new Map<string, Promise<void>>();
  /** One shared delegated-work policy host for runtime invalidation. */
  readonly delegatedWorkHost: DelegatedWorkHost;

  constructor(
    cfg: Config,
    toolFactory?: SubagentToolFactory,
    embeddingProvider?: EmbeddingProvider,
    host?: SubagentHost,
    memoryStoreFactory?: SubagentMemoryStoreFactory,
    delegatedWorkHost?: DelegatedWorkHost,
  ) {
    this.cfg = cfg;
    this.goblinHome = cfg.goblinHome;
    this.toolFactory = toolFactory ?? null;
    this.embeddingProvider = embeddingProvider;
    this.memoryStoreFactory = memoryStoreFactory ?? ((home, provider) => provider
      ? new MemoryStore(home, undefined, { embeddings: provider })
      : new MemoryStore(home));
    // Lazily construct the production host on first invocation. Besides
    // preserving deployment-lifetime caching, this keeps late test-module
    // substitution from freezing vendor constructors at runner creation.
    this.host = host ?? null;
    this.delegatedWorkHost = delegatedWorkHost ?? new DelegatedWorkHost(cfg.goblinHome);
  }

  /**
   * Spawn a new subagent and kick off its first turn.
   *
   * Generic (no `name`): creates a host-owned record under
   * `state/delegated-work/runs/<id>/`, persists a pi session in the same run
   * directory, and inherits the caller's Execution Environment plus frozen
   * resolved skill manifest (exact files, no re-discovery).
   *
   * Named (`name` provided): loads
   * `$GOBLIN_HOME/workspace/agents/<name>/AGENTS.md` (required), creates a
   * host-owned record under `state/delegated-work/runs/<id>/`, and builds a
   * Pi resource preparation that uses the AGENTS.md content as the system
   * prompt and pins skill discovery to the agent's own `.agents/skills/`
   * catalog — strictly isolated from Goblin and caller skills.
   *
   * Returns immediately with a handle; `handle.result` resolves when the
   * subagent reaches Pi's fully settled state (or rejects on error).
   */
  async spawn(options: SpawnOptions): Promise<SubagentHandle> {
    if (this.disposed) {
      throw new Error("SubagentRunner is disposed");
    }

    const spawnerDepth = options.depth ?? 0;
    if (spawnerDepth < 0) {
      throw new Error(`Invalid depth: ${spawnerDepth}`);
    }
    const newDepth = spawnerDepth + 1;
    if (newDepth > MAX_SUBAGENT_DEPTH) {
      throw new Error(`Maximum subagent depth reached (${MAX_SUBAGENT_DEPTH})`);
    }

    // Reject spawns from a subagent that is no longer running.
    if (options.spawnedBy !== undefined) {
      const parent = this.activeSubagents.get(options.spawnedBy);
      if (parent !== undefined && parent.status !== "running") {
        throw new Error("Cannot spawn subagent from a non-running parent");
      }
      if (parent?.runtimeFenced === true) {
        throw new Error("Cannot spawn subagent from an invalidated runtime");
      }
    }

    // Prune terminal subagents before creating new ones.
    this.pruneTerminal();

    // Sanitise name to prevent path traversal.
    if (options.name !== undefined && !VALID_NAME_RE.test(options.name)) {
      throw new Error(
        `Invalid agent name '${options.name}': must match ${VALID_NAME_RE.source}`,
      );
    }

    const id = randomUUID();
    const spawnedAt = new Date().toISOString();
    const parent = options.spawnedBy === undefined
      ? undefined
      : this.activeSubagents.get(options.spawnedBy);
    const authority = options.authority;
    if (
      authority.kind !== "surface" ||
      typeof authority.sourceSurfaceId !== "string" ||
      authority.activeScope === undefined
    ) {
      const err = new Error(
        `Subagent spawn requires a SurfaceMemoryAuthority, got ${authority.kind ?? typeof authority}`,
      );
      log.warn("subagent spawn rejected: invalid authority", boundedError(err));
      throw err;
    }
    const caller: SurfaceMemoryCaller =
      options.name !== undefined
        ? { kind: "named-subagent", name: options.name }
        : { kind: "anonymous-subagent" };

    let role: SubagentRole;
    let kind: DelegatedWorkKind;
    let definition: NamedAgentDefinition | null;
    let displayName: string | null;
    let inheritance: GenericSubagentInheritance | null;

    if (options.name !== undefined) {
      role = "named";
      kind = "named-subagent";
      definition = loadNamedAgent(this.cfg.goblinHome, options.name);
      displayName = options.name;
      inheritance = null;
    } else {
      role = "generic";
      kind = "generic-subagent";
      definition = null;
      displayName = null;
      inheritance = options.inheritance;
    }

    // A delegated context is trusted runtime authority, not model input. A
    // recursive child inherits the root epoch; a top-level invocation starts a
    // fresh epoch. Tests and legacy callers that omit a context are bridged to
    // an attached ownership derived from the captured authority; production
    // callers always provide an explicit delegated runtime context.
    let delegatedOwnership: AttachedDelegatedWorkOwnership;
    if (options.delegatedContext !== undefined) {
      if (parent !== undefined) {
        if (parent.delegatedOwnership === null) {
          throw new Error("delegated child has no attached parent ownership");
        }
        if (!sameDelegatedRuntimeContext(options.delegatedContext, parent.delegatedOwnership)) {
          throw new Error("delegated child authority differs from its attached parent");
        }
        delegatedOwnership = parent.delegatedOwnership;
      } else {
        delegatedOwnership = {
          ...options.delegatedContext,
          lifetime: "attached",
          ownershipEpochId: randomUUID(),
        };
      }
    } else if (parent?.delegatedOwnership !== undefined && parent.delegatedOwnership !== null) {
      delegatedOwnership = parent.delegatedOwnership;
    } else {
      delegatedOwnership = {
        ownerConversationId: authority.sourceSurfaceId,
        runtimeId: DelegatedWorkHost.newRuntimeId(),
        originSurfaceId: authority.sourceSurfaceId,
        executionEnvironment: inheritance?.executionEnvironment ?? personalEnvironment(),
        lifetime: "attached",
        ownershipEpochId: randomUUID(),
      };
    }

    if (delegatedOwnership.originSurfaceId !== authority.sourceSurfaceId) {
      throw new Error("delegated origin Surface does not match captured memory authority");
    }
    if (inheritance !== null && !environmentsEqual(
      inheritance.executionEnvironment,
      delegatedOwnership.executionEnvironment,
    )) {
      throw new Error("generic delegated environment differs from inherited authority");
    }

    // `spawnedBy` is the caller's identity for cascade cancellation: either a
    // parent subagent id or the owning session id for a top-level spawn.
    const spawnedBy = options.spawnedBy ?? null;
    const delegatedRegistration = this.delegatedWorkHost.reserveAttached(id, delegatedOwnership);

    // Create the host-owned record before any kind-specific execution state.
    // The record's run directory is where the Pi session files live.
    let runDir: string;
    try {
      const recordResult = this.delegatedWorkHost.createAttachedRecord(
        id,
        kind,
        displayName,
        newDepth,
        delegatedOwnership,
      );
      runDir = recordResult.runDir;
    } catch (err) {
      delegatedRegistration.release();
      throw err;
    }

    const history = { kind: "create" as const, sessionDir: runDir };
    let preparedExecution: SubagentExecution;
    try {
      // Prepare the execution CWD before creating the authoritative running
      // record. The Pi host prepares the exact new history target; model
      // activation remains deferred until the lease is run.
      const cwd =
        role === "named"
          ? namedAgentDir(this.cfg.goblinHome, options.name as string)
          : genericExecutionCwd(inheritance, this.cfg.goblinHome);
      preparedExecution = this.getHost().prepare(
        preparationFor(cwd, history, role, definition, inheritance),
      );
    } catch (err) {
      this.abandonInvocation(id, 0);
      delegatedRegistration.release();
      throw err;
    }

    // Install both public and internal settlement before execution starts.
    const result = deferred<string>();
    const settlement = deferred<void>();

    const instance: SubagentInstance = {
      id,
      name: displayName,
      role,
      status: "running",
      authority,
      caller,
      depth: newDepth,
      spawnedAt,
      spawnedBy,
      dir: runDir,
      invocationIndex: 0,
      history,
      initialPrompt: options.prompt,
      onStatusUpdate: prefixStatusCallback(displayName ?? id.slice(0, 8), options.onStatusUpdate),
      // Store raw callback for nested spawning (prevents prefix stacking)
      rawStatusCallback: options.onStatusUpdate,
      definition,
      inheritance,
      execution: preparedExecution,
      delegatedOwnership,
      delegatedRegistration,
      runtimeFenced: false,
      deliveryState: "pending",
      completionClaimed: false,
      settlement: settlement.promise,
      resolveSettlement: () => settlement.resolve(undefined),
      rejectSettlement: settlement.reject,
      stopPromise: null,
      settlementStarted: false,
      result: result.promise,
      resolveResult: result.resolve,
      rejectResult: result.reject,
    };
    this.activeSubagents.set(id, instance);

    try {
      delegatedRegistration.attach(this.attachedAdapterFor(instance));
    } catch (err) {
      this.activeSubagents.delete(id);
      delegatedRegistration.release();
      this.abandonInvocation(id, instance.invocationIndex);
      const failures: unknown[] = [];
      await stopPreparedExecution(preparedExecution, id).catch((failure) => failures.push(failure));
      const failure = combineFailures([err, ...failures], "Subagent delegated registration failed") ?? err;
      result.reject(failure);
      settlement.reject(failure);
      throw failure;
    }

    log.debug("subagent spawned", {
      id,
      role,
      name: displayName,
      depth: newDepth,
      spawnedBy,
    });

    // Kick off LLM execution. We don't await here — spawn returns the handle
    // immediately so callers can choose between awaiting `handle.result` and
    // tracking via `list()`. Errors during startup land on `result` (the
    // tool handler awaits it and surfaces failures as tool errors).
    this.startInstance(instance);

    // The deferred helper already observes internal rejections; callers still
    // receive the ordinary public result promise.
    return { id, status: "running", result: result.promise };
  }

  /**
   * Resume a persisted subagent and send it a follow-up prompt.
   *
   * Loads the subagent's `meta.json` to locate its history directory and
   * selects the existing `.jsonl` file without rediscovering it in the host,
   * reconstructs a `SubagentInstance`, and runs the new prompt through
   * `runInstance()` — reusing all execution wiring (status callbacks, error
   * handling, meta persistence).
   *
   * Throws "Subagent not found" only when no matching metadata or session
   * file exists. Present but malformed or mismatched state raises a diagnostic
   * metadata error instead.
   *
   * A revived generic subagent inherits the *reviving* runtime's frozen
   * environment and skill authority (`inheritance`), mirroring the
   * memory-authority rule: revival is a new invocation. Named agents ignore
   * it and keep their isolated catalog.
   */
  async revive(
    parentCapture: CapturedMemoryContext,
    inheritance: GenericSubagentInheritance | null,
    id: string,
    prompt: string,
    onStatusUpdate?: (message: string) => void,
    onAttached?: () => void | Promise<void>,
    delegatedContext?: DelegatedRuntimeContext,
  ): Promise<string> {
    if (this.disposed) {
      throw new Error("SubagentRunner is disposed");
    }

    // Guard against concurrent revive() of the same subagent ID.
    if (this.revivesInProgress.has(id)) {
      throw new SubagentReviveBusyError(id, "Subagent revive already in progress");
    }

    // Reject if this subagent is already active and running.
    const existing = this.activeSubagents.get(id);
    if (existing !== undefined && existing.status === "running") {
      throw new SubagentReviveBusyError(id, "Subagent is already running");
    }

    this.revivesInProgress.add(id);

    if (
      parentCapture.kind !== "surface" ||
      parentCapture.authority.kind !== "surface" ||
      typeof parentCapture.authority.sourceSurfaceId !== "string"
    ) {
      this.revivesInProgress.delete(id);
      const err = new Error(
        `Revival requires a Surface-backed parent memory context, got ${parentCapture.kind ?? typeof parentCapture}`,
      );
      log.warn("subagent revive rejected: invalid parent authority", boundedError(err));
      throw err;
    }

    // Load the host-owned record. Legacy two-tree lookups are no longer
    // performed at runtime; offline migration moved them into the new store.
    let record: DelegatedWorkRecord | null;
    try {
      record = this.delegatedWorkHost.loadRecord(id);
    } catch (err) {
      // A malformed record must not leave the revive guard latched; the same id
      // has to be revivable again once the record is repaired.
      this.revivesInProgress.delete(id);
      throw err;
    }
    if (record === null) {
      this.revivesInProgress.delete(id);
      throw new SubagentReviveRejectedError("Subagent not found");
    }

    const role: SubagentRole = record.kind === "generic-subagent" ? "generic" : "named";
    const displayName = record.name;

    // A generic revival without the reviving runtime's environment/manifest
    // authority would either run under the wrong CWD or re-run discovery.
    // Both violate decision 0034 and the execution-environment contract.
    if (role === "generic" && inheritance === null) {
      this.revivesInProgress.delete(id);
      throw new Error(
        `Generic subagent '${id}' revival requires the reviving runtime's resolved skill manifest and execution environment`,
      );
    }

    const runDir = this.delegatedWorkHost.runDir(id);

    // Find the persisted session file inside the subagent's run directory.
    const sessionFile = findSessionFile(runDir);
    if (sessionFile === null) {
      this.revivesInProgress.delete(id);
      throw new SubagentReviveRejectedError("Subagent not found");
    }

    // Revival is a new invocation: it inherits the reviving parent runtime's
    // captured Surface authority.
    const authority = parentCapture.authority;
    const caller: SurfaceMemoryCaller =
      role === "named" && displayName !== null
        ? { kind: "named-subagent", name: displayName }
        : { kind: "anonymous-subagent" };

    // Production callers always provide a delegated runtime context. Tests and
    // legacy callers that omit it are bridged to an attached ownership derived
    // from the captured authority.
    let effectiveContext: DelegatedRuntimeContext;
    if (delegatedContext !== undefined) {
      effectiveContext = delegatedContext;
    } else {
      effectiveContext = {
        ownerConversationId: authority.sourceSurfaceId,
        runtimeId: DelegatedWorkHost.newRuntimeId(),
        originSurfaceId: authority.sourceSurfaceId,
        executionEnvironment: role === "generic" && inheritance !== null
          ? inheritance.executionEnvironment
          : personalEnvironment(),
      };
    }
    const delegatedOwnership: AttachedDelegatedWorkOwnership = {
      ...effectiveContext,
      lifetime: "attached",
      ownershipEpochId: randomUUID(),
    };

    if (delegatedOwnership.originSurfaceId !== authority.sourceSurfaceId) {
      this.revivesInProgress.delete(id);
      throw new Error("delegated revival Surface does not match captured memory authority");
    }
    if (role === "generic" && inheritance !== null && !environmentsEqual(
      inheritance.executionEnvironment,
      delegatedOwnership.executionEnvironment,
    )) {
      this.revivesInProgress.delete(id);
      throw new Error("generic delegated revival environment differs from inherited authority");
    }

    // Validate that the topic directory exists if the subagent has a topic scope.
    // This catches archived topics and rejects regular files masquerading as
    // scope containers. Only ENOENT is treated as absence; other stat errors
    // remain diagnostic and propagate to the caller.
    if (authority.activeScope.topicScope !== "general") {
      const chatId = authority.activeScope.chatId;
      const topicId = authority.activeScope.topicScope.topicId;
      try {
        assertTopicDirectory(this.cfg.goblinHome, id, chatId, topicId);
      } catch (err) {
        this.revivesInProgress.delete(id);
        throw err;
      }
    }

    // Determine cwd from the new invocation's authority, just as spawn() does.
    const cwd =
      role === "named" && displayName !== null
        ? namedAgentDir(this.cfg.goblinHome, displayName)
        : genericExecutionCwd(inheritance, this.cfg.goblinHome);

    // Preserve the exact lexical history target. The Pi host opens exactly this
    // file and does not rediscover a latest history.
    const history = { kind: "open" as const, sessionDir: runDir, sessionFile };

    // Rebuild the named-agent definition if the subagent is named.
    let definition: NamedAgentDefinition | null = null;
    if (role === "named" && displayName !== null) {
      try {
        definition = loadNamedAgent(this.cfg.goblinHome, displayName);
      } catch (err) {
        this.revivesInProgress.delete(id);
        if (err instanceof NamedAgentNotFoundError) {
          throw new SubagentReviveRejectedError(
            `Named agent '${displayName}' definition missing; cannot revive`,
          );
        }
        throw err;
      }
    }

    const delegatedRegistration = this.delegatedWorkHost.reserveAttached(id, delegatedOwnership);

    // Append the revival invocation to the record before any Pi lease runs.
    let revivedRecord: DelegatedWorkRecord;
    try {
      ({ record: revivedRecord } = this.delegatedWorkHost.appendAttachedRevival(id, delegatedOwnership));
    } catch (err) {
      delegatedRegistration.release();
      this.revivesInProgress.delete(id);
      throw err;
    }

    let preparedExecution: SubagentExecution;
    try {
      preparedExecution = this.getHost().prepare(
        preparationFor(
          cwd,
          history,
          role,
          definition,
          role === "generic" ? inheritance : null,
        ),
      );
    } catch (err) {
      this.abandonInvocation(id, revivedRecord.invocations.length - 1);
      delegatedRegistration.release();
      this.revivesInProgress.delete(id);
      throw err;
    }

    // Install both public and internal settlement before attachment can race
    // cancellation or startup.
    const result = deferred<string>();
    const settlement = deferred<void>();

    const instance: SubagentInstance = {
      id,
      name: displayName,
      role,
      status: "running",
      authority,
      caller,
      depth: record.depth,
      spawnedAt: record.createdAt,
      spawnedBy: null,
      dir: runDir,
      invocationIndex: revivedRecord.invocations.length - 1,
      history,
      initialPrompt: prompt,
      onStatusUpdate: prefixStatusCallback(displayName ?? id.slice(0, 8), onStatusUpdate),
      // Store raw callback for nested spawning (prevents prefix stacking)
      rawStatusCallback: onStatusUpdate,
      definition,
      inheritance: role === "generic" ? inheritance : null,
      execution: preparedExecution,
      delegatedOwnership,
      delegatedRegistration,
      runtimeFenced: false,
      deliveryState: "pending",
      completionClaimed: false,
      settlement: settlement.promise,
      resolveSettlement: () => settlement.resolve(undefined),
      rejectSettlement: settlement.reject,
      stopPromise: null,
      settlementStarted: false,
      result: result.promise,
      resolveResult: result.resolve,
      rejectResult: result.reject,
    };
    this.activeSubagents.set(id, instance);
    try {
      delegatedRegistration.attach(this.attachedAdapterFor(instance));
    } catch (err) {
      this.activeSubagents.delete(id);
      delegatedRegistration.release();
      const stopFailures: unknown[] = [];
      await this.stopAndCollect(instance, stopFailures);
      this.abandonInvocation(id, instance.invocationIndex);
      const failure = combineFailures([err, ...stopFailures], "Subagent delegated registration failed") ?? err;
      result.reject(failure);
      settlement.reject(failure);
      this.revivesInProgress.delete(id);
      throw failure;
    }
    if (onAttached) {
      try {
        await onAttached();
      } catch (err) {
        this.activeSubagents.delete(id);
        this.revivesInProgress.delete(id);
        const stopFailures: unknown[] = [];
        await this.stopAndCollect(instance, stopFailures);
        const stopFailure = stopFailures[0];
        const failure = combineFailures(
          [err, stopFailure].filter((value) => value !== undefined),
          "Subagent revive cleanup failed",
        ) ?? err;
        result.reject(failure);
        settlement.reject(failure);
        instance.deliveryState = "suppressed";
        teardownInstance(instance);
        this.abandonInvocation(id, instance.invocationIndex);
        throw failure;
      }
    }

    // Cancellation can run while an asynchronous attachment callback yields.
    // It owns the terminal state, so do not resurrect this instance on disk or
    // launch a fresh execution after it has been cancelled.
    if (instance.status !== "running") {
      let stopFailure: unknown;
      if (instance.stopPromise !== null) {
        try {
          await instance.stopPromise;
        } catch (error) {
          stopFailure = error;
        }
      }
      if (stopFailure === undefined) settlement.resolve(undefined);
      else settlement.reject(stopFailure);
      const completed = result.promise.finally(() => {
        this.revivesInProgress.delete(id);
      });
      completed.catch(() => {});
      return completed;
    }

    log.debug("subagent revived", { id, role, name: displayName });

    // Kick off execution — same pipeline as spawn().
    this.startInstance(instance);
    // Resolve the revive only after its bookkeeping (revivesInProgress) is
    // cleared, so a subsequent revive() of the same id observes a clean
    // slate. (The await in callers thus sees the guard already removed.)
    const completed = result.promise.finally(() => {
      this.revivesInProgress.delete(id);
    });
    completed.catch(() => {});
    return completed;
  }

  /**
   * Close an invocation that never reached execution. An abandoned attempt is
   * terminally interrupted with no delivery, so the record never claims a run
   * is alive and the next revival can append a fresh invocation.
   */
  private abandonInvocation(id: string, index: number): void {
    try {
      const record = this.delegatedWorkHost.loadRecord(id);
      const invocation = record?.invocations[index];
      if (invocation === undefined || invocation.status !== "running") return;
      this.delegatedWorkHost.interruptInvocation(id, index);
    } catch (err) {
      // Cleanup must not mask the failure that triggered it. A record left
      // `running` is reconciled by `reconcileStartup()` on the next start.
      log.error("abandon invocation record close failed", { id, index, ...boundedError(err) });
    }
  }

  /**
   * Adapt one attached invocation to the generic delegated-work host. The
   * host, not TurnDispatcher, decides when this adapter is fenced/cancelled.
   */
  private attachedAdapterFor(instance: SubagentInstance): AttachedWorkAdapter {
    const ownership = instance.delegatedOwnership;
    if (ownership === null) throw new Error("attached adapter requires delegated ownership");
    return {
      fence: () => {
        instance.runtimeFenced = true;
      },
      cancel: () => this.cancelAttachedOwnership(ownership.ownershipEpochId),
      quiesce: () => this.quiesceAttachedOwnership(ownership.ownershipEpochId),
    };
  }

  private cancelAttachedOwnership(epochId: string): Promise<void> {
    const prior = this.attachedCancellationPromises.get(epochId);
    if (prior !== undefined) return prior;
    const cancellation = this.cancelAttachedOwnershipImpl(epochId);
    this.attachedCancellationPromises.set(epochId, cancellation);
    void cancellation.then(
      () => {
        if (this.attachedCancellationPromises.get(epochId) === cancellation) {
          this.attachedCancellationPromises.delete(epochId);
        }
      },
      () => {
        if (this.attachedCancellationPromises.get(epochId) === cancellation) {
          this.attachedCancellationPromises.delete(epochId);
        }
      },
    );
    return cancellation;
  }

  private async cancelAttachedOwnershipImpl(epochId: string): Promise<void> {
    const instances = [...this.activeSubagents.values()].filter(
      (instance) => instance.delegatedOwnership?.ownershipEpochId === epochId,
    );
    const targets: SubagentInstance[] = [];
    const completionClaims: SubagentInstance[] = [];
    const pendingDeliveries: SubagentInstance[] = [];
    const cleanupPending: SubagentInstance[] = [];

    // Claim every target synchronously before any stop await. This closes the
    // parent/child and completion/invalidation races for the whole epoch.
    for (const instance of instances) {
      if (instance.status !== "running") {
        if (instance.deliveryState === "pending") pendingDeliveries.push(instance);
        else if (instance.delegatedRegistration !== null) cleanupPending.push(instance);
        continue;
      }
      if (instance.completionClaimed) {
        completionClaims.push(instance);
      } else {
        instance.status = "cancelled";
        instance.deliveryState = "suppressed";
        instance.rejectResult(new Error("Subagent was cancelled"));
        targets.push(instance);
      }
    }

    const failures: unknown[] = [];
    await Promise.all([
      ...completionClaims.map(async (instance) => {
        try {
          await waitWithTimeout(instance.result, CANCEL_COMPLETION_TIMEOUT_MS, () =>
            new Error("Subagent completion wait timed out during runtime invalidation"));
        } catch (error) {
          failures.push(error);
        }
        if (instance.status === "completed" && instance.deliveryState === "pending") {
          this.suppressPendingDelivery(instance, failures);
        }
      }),
      ...pendingDeliveries.map(async (instance) => {
        this.suppressPendingDelivery(instance, failures);
      }),
      ...cleanupPending.map(async (instance) => {
        const targetFailures: unknown[] = [];
        await this.stopAndCollect(instance, targetFailures, "attached subagent cleanup retry failed");
        try {
          if (instance.status === "cancelled") {
            this.delegatedWorkHost.cancelInvocation(instance.id, instance.invocationIndex);
          } else {
            this.delegatedWorkHost.suppressDelivery(instance.id, instance.invocationIndex);
          }
        } catch (error) {
          targetFailures.push(error);
          log.error("attached subagent cleanup retry record failed", {
            id: instance.id,
            ...boundedError(error),
          });
        }
        if (instance.settlementStarted) await collectSettlement(instance, targetFailures);
        else instance.resolveSettlement();
        failures.push(...targetFailures);
        teardownInstance(instance, targetFailures.length === 0);
      }),
      ...targets.map(async (instance) => {
        const targetFailures: unknown[] = [];
        await this.stopAndCollect(instance, targetFailures, "attached subagent stop failed");
        try {
          this.delegatedWorkHost.cancelInvocation(instance.id, instance.invocationIndex);
        } catch (error) {
          targetFailures.push(error);
          log.error("attached subagent cancellation record failed", {
            id: instance.id,
            ...boundedError(error),
          });
        }
        if (instance.settlementStarted) await collectSettlement(instance, targetFailures);
        else instance.resolveSettlement();
        failures.push(...targetFailures);
        // Keep the host registration when cleanup did not prove quiescence.
        // DelegatedWorkHost must retain ownership of the failed entry so a
        // later invalidation retry can make another cancellation attempt.
        teardownInstance(instance, targetFailures.length === 0);
      }),
    ]);

    const failure = combineFailures(failures, "Attached subagent cancellation failed");
    if (failure !== null) throw failure;
  }

  /** Suppress a terminal result that has not yet been accepted by its caller. */
  private suppressPendingDelivery(instance: SubagentInstance, failures: unknown[]): void {
    if (instance.deliveryState !== "pending") return;
    let persisted = true;
    try {
      this.delegatedWorkHost.suppressDelivery(instance.id, instance.invocationIndex);
      instance.deliveryState = "suppressed";
    } catch (error) {
      persisted = false;
      failures.push(error);
      log.error("attached subagent delivery suppression record failed", {
        id: instance.id,
        ...boundedError(error),
      });
    }
    // A failed record write leaves the host registration in place. The
    // lifecycle owner must not report quiescence after losing its retry handle.
    teardownInstance(instance, persisted);
  }

  /**
   * A blocking tool calls this only after it has accepted the terminal text.
   * Keeping the acknowledgement explicit prevents execution success from
   * being confused with delivery success when runtime invalidation wins the
   * race between those two events.
   */
  acknowledgeDelivery(id: string): void {
    const instance = this.activeSubagents.get(id);
    if (instance === undefined) throw new Error("Subagent not found");
    if (instance.deliveryState === "delivered") return;
    if (instance.status !== "completed" || instance.deliveryState !== "pending") {
      throw new Error(`Subagent '${id}' has no pending delivery`);
    }
    if (instance.runtimeFenced) {
      throw new RuntimeFenceError(id);
    }
    this.delegatedWorkHost.acknowledgeDelivery(instance.id, instance.invocationIndex);
    instance.deliveryState = "delivered";
    teardownInstance(instance);
    log.debug("subagent delivery acknowledged", { id });
  }

  /** Explicit owner cancellation is delegated to the policy host. */
  async cancelByConversation(ownerConversationId: string): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.delegatedWorkHost.cancelByConversation(ownerConversationId);
    } catch (error) {
      failures.push(error);
    }
    // Preserve cancellation for pre-host direct-runner records. This is an
    // explicit user action, not Conversation-runtime disposal; attached work
    // itself is always cancelled through DelegatedWorkHost above.
    try {
      await this.cancelBySession(ownerConversationId);
    } catch (error) {
      failures.push(error);
    }
    const failure = combineFailures(failures, "Subagent owner cancellation failed");
    if (failure !== null) throw failure;
  }

  private quiesceAttachedOwnership(epochId: string): Promise<void> {
    const prior = this.attachedQuiescencePromises.get(epochId);
    if (prior !== undefined) return prior;
    const quiescence = this.quiesceAttachedOwnershipImpl(epochId);
    this.attachedQuiescencePromises.set(epochId, quiescence);
    void quiescence.then(
      () => {
        if (this.attachedQuiescencePromises.get(epochId) === quiescence) {
          this.attachedQuiescencePromises.delete(epochId);
        }
      },
      () => {
        if (this.attachedQuiescencePromises.get(epochId) === quiescence) {
          this.attachedQuiescencePromises.delete(epochId);
        }
      },
    );
    return quiescence;
  }

  private async quiesceAttachedOwnershipImpl(epochId: string): Promise<void> {
    const failures: unknown[] = [];
    const instances = [...this.activeSubagents.values()].filter(
      (instance) => instance.delegatedOwnership?.ownershipEpochId === epochId,
    );
    await Promise.all(instances.map(async (instance) => {
      if (!instance.settlementStarted) {
        instance.resolveSettlement();
        return;
      }
      await collectSettlement(instance, failures);
    }));
    const failure = combineFailures(failures, "Attached subagent quiescence failed");
    if (failure !== null) throw failure;
  }

  /**
   * Snapshot of all known subagent instances.
   */
  list(ownerConversationId?: string): SubagentInfo[] {
    const out: SubagentInfo[] = [];
    for (const inst of this.activeSubagents.values()) {
      if (
        ownerConversationId !== undefined &&
        inst.delegatedOwnership?.ownerConversationId !== ownerConversationId
      ) {
        continue;
      }
      const info: SubagentInfo = {
        id: inst.id,
        name: inst.name,
        role: inst.role,
        status: inst.status,
        spawnedAt: inst.spawnedAt,
        spawnedBy: inst.spawnedBy,
      };
      if (inst.delegatedOwnership !== null) {
        info.ownerConversationId = inst.delegatedOwnership.ownerConversationId;
        info.runtimeId = inst.delegatedOwnership.runtimeId;
        info.lifetime = inst.delegatedOwnership.lifetime;
        info.originSurfaceId = inst.delegatedOwnership.originSurfaceId;
        info.executionEnvironment = inst.delegatedOwnership.executionEnvironment;
        info.ownershipEpochId = inst.delegatedOwnership.ownershipEpochId;
        info.deliveryState = inst.deliveryState;
      }
      out.push(info);
    }
    return out;
  }

  /**
   * Cancel an active subagent. The runner owns the policy and metadata
   * transition; the host receives only the Pi stop mechanism.
   */
  async cancel(id: string, ownerConversationId?: string): Promise<void> {
    const instance = this.activeSubagents.get(id);
    if (instance === undefined) {
      throw new Error("Subagent not found");
    }
    if (
      ownerConversationId !== undefined &&
      instance.delegatedOwnership?.ownerConversationId !== ownerConversationId
    ) {
      throw new Error("Subagent not found");
    }
    if (instance.status !== "running") {
      if (instance.status === "completed" && instance.deliveryState === "pending") {
        const failures: unknown[] = [];
        this.suppressPendingDelivery(instance, failures);
        const failure = combineFailures(failures, "Subagent delivery cancellation failed");
        if (failure !== null) throw failure;
      }
      return;
    }

    // A host success reservation wins over cancellation, but the operation
    // still waits for final cleanup/metadata outcome so it cannot report a
    // false quiescent success.
    if (instance.completionClaimed) {
      const failures: unknown[] = [];
      try {
        await waitWithTimeout(instance.result, CANCEL_COMPLETION_TIMEOUT_MS, () =>
          new Error("Subagent completion wait timed out during cancel"));
      } catch (err) {
        failures.push(err);
      }
      if ((instance.status as SubagentStatus) === "completed" && instance.deliveryState === "pending") {
        this.suppressPendingDelivery(instance, failures);
      }
      const failure = combineFailures(failures, "Subagent cancellation failed");
      if (failure !== null) throw failure;
      return;
    }

    // Claim cancellation synchronously so a terminal Pi event cannot win
    // after this point. Capture the lease before awaiting; no coordinator
    // path may replace it after the lifecycle claim.
    instance.status = "cancelled";
    instance.deliveryState = "suppressed";
    instance.rejectResult(new Error("Subagent was cancelled"));
    const failures: unknown[] = [];
    await this.stopAndCollect(instance, failures, "subagent execution stop failed during cancel");

    try {
      this.delegatedWorkHost.cancelInvocation(instance.id, instance.invocationIndex);
    } catch (err) {
      failures.push(err);
      log.error("cancel record close failed — disk state may be stale", {
        id,
        ...boundedError(err),
      });
    }

    if (instance.settlementStarted) await collectSettlement(instance, failures);
    else instance.resolveSettlement();
    teardownInstance(instance, failures.length === 0);
    log.debug("subagent cancelled", { id });
    const failure = combineFailures(failures, "Subagent cancellation failed");
    if (failure !== null) throw failure;
  }

  /**
   * Cancel every subagent in the spawn tree rooted at the given session id.
   *
   * Walks `spawnedBy` parentage, marks all non-terminal instances as
   * `cancelled` synchronously before any await, then tears them down. Cleanup
   * continues for every target; durable metadata failures are rethrown after
   * all targets have been attempted.
   */
  async cancelBySession(sessionId: string): Promise<void> {
    // 1. Collect all descendants in the session's spawn tree (BFS by parentage).
    const queue: string[] = [];
    const collected = new Set<string>();
    for (const [id, inst] of this.activeSubagents) {
      if (inst.spawnedBy === sessionId && !collected.has(id)) {
        queue.push(id);
        collected.add(id);
      }
    }
    let index = 0;
    while (index < queue.length) {
      const parentId = queue[index];
      index += 1;
      for (const [id, inst] of this.activeSubagents) {
        if (inst.spawnedBy === parentId && !collected.has(id)) {
          queue.push(id);
          collected.add(id);
        }
      }
    }

    // 2. Mark every cancellable instance synchronously before any await.
    const targets: SubagentInstance[] = [];
    const completionClaims: SubagentInstance[] = [];
    for (const id of queue) {
      const instance = this.activeSubagents.get(id);
      if (instance !== undefined && instance.status === "running") {
        if (instance.completionClaimed) {
          completionClaims.push(instance);
        } else {
          instance.status = "cancelled";
          instance.deliveryState = "suppressed";
          instance.rejectResult(new Error("Subagent was cancelled"));
          targets.push(instance);
        }
      }
    }

    // 3. Clean up each targeted instance concurrently. Start all aborts in
    //    parallel so a parent that is blocked on a child result can be
    //    unblocked when the child's abort settles.
    const failures: unknown[] = [];
    await Promise.all([
      ...completionClaims.map(async (instance) => {
        try {
          await waitWithTimeout(instance.result, CANCEL_COMPLETION_TIMEOUT_MS, () =>
            new Error("Subagent completion wait timed out during cascade cancel"));
        } catch (err) {
          failures.push(err);
        }
        if (instance.status === "completed" && instance.deliveryState === "pending") {
          this.suppressPendingDelivery(instance, failures);
        }
      }),
      ...targets.map(async (instance) => {
        await this.stopAndCollect(instance, failures, "cancelBySession execution stop failed");

        try {
          this.delegatedWorkHost.cancelInvocation(instance.id, instance.invocationIndex);
        } catch (err) {
          failures.push(err);
          log.error("cancelBySession record close failed", {
            id: instance.id,
            ...boundedError(err),
          });
        }

        if (instance.settlementStarted) await collectSettlement(instance, failures);
        else instance.resolveSettlement();
        teardownInstance(instance);
      }),
    ]);

    if (targets.length > 0 || completionClaims.length > 0) {
      log.debug("cascade-cancel: subagents cancelled", {
        count: targets.length,
        completionClaims: completionClaims.length,
        sessionId,
      });
    }
    const failure = combineFailures(failures, "Subagent cascade cancellation failed");
    if (failure !== null) throw failure;
  }

  /**
   * Gracefully shut down all active subagents.
   * Stops running invocation leases and clears the map.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...this.activeSubagents.keys()];
    const failures: unknown[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const instance = this.activeSubagents.get(id);
        if (!instance) return;
        // Only cancel instances that are still running. Completed/errored/
        // cancelled instances should keep their existing status — don't
        // overwrite a successful completion with "cancelled".
        if (instance.status === "running" && instance.completionClaimed) {
          try {
            await waitWithTimeout(instance.result, CANCEL_COMPLETION_TIMEOUT_MS, () =>
              new Error("Subagent completion wait timed out during dispose"));
          } catch (err) {
            failures.push(err);
          }
        } else if (instance.status === "running") {
          // Mark cancelled before any await so a concurrent runInstance sees
          // the non-running status and does not activate a new lease.
          instance.status = "cancelled";
          instance.rejectResult(new Error("Subagent was cancelled"));
          await this.stopAndCollect(instance, failures, "dispose execution stop failed");
          try {
            this.delegatedWorkHost.cancelInvocation(instance.id, instance.invocationIndex);
          } catch (err) {
            failures.push(err);
            log.error("dispose record close failed", {
              id,
              ...boundedError(err),
            });
          }
          if (instance.settlementStarted) await collectSettlement(instance, failures);
          else instance.resolveSettlement();
        } else if (instance.status === "cancelled") {
          if (instance.settlementStarted) await collectSettlement(instance, failures);
          else instance.resolveSettlement();
        } else if (instance.status === "completed" && instance.deliveryState === "pending") {
          this.suppressPendingDelivery(instance, failures);
        }
        teardownInstance(instance);
      }),
    );
    this.activeSubagents.clear();
    log.debug("SubagentRunner disposed", { count: ids.length });
    const failure = combineFailures(failures, "Subagent disposal failed");
    if (failure !== null) throw failure;
  }

  /**
   * Stop an instance's execution and collect any failure into `failures`.
   *
   * Encapsulates the repeated stop-and-collect pattern: call
   * `stopInstanceExecution`, await the resulting promise (if any), and push
   * any rejection into the caller's `failures` accumulator. When `logLabel`
   * is provided, a rejection is also logged at error level with the instance
   * id — preserving the per-call-site logging of the inlined originals.
   */
  private async stopAndCollect(
    instance: SubagentInstance,
    failures: unknown[],
    logLabel?: string,
  ): Promise<void> {
    const stopPromise = stopInstanceExecution(instance);
    if (stopPromise === null) return;
    try {
      await stopPromise;
    } catch (err) {
      failures.push(err);
      if (logLabel !== undefined) {
        log.error(logLabel, { id: instance.id, ...boundedError(err) });
      }
    }
  }

  /**
   * Remove terminal instances from the map to bound memory growth.
   * Called lazily on each `spawn()`.
   *
   * A terminal instance is only pruned if no other instance claims it as
   * a parent (`spawnedBy`). This preserves the ancestry chain needed by
   * `cancelBySession`'s BFS traversal — pruning a terminal parent while
   * it has running descendants would orphan them from the session tree.
   * Terminal subtrees are pruned leaf-first over successive `spawn()` calls.
   */
  private pruneTerminal(): void {
    const parents = new Set<string>();
    for (const inst of this.activeSubagents.values()) {
      if (inst.spawnedBy !== null) {
        parents.add(inst.spawnedBy);
      }
    }
    for (const [id, inst] of this.activeSubagents) {
      if (
        inst.status !== "running" &&
        inst.deliveryState !== "pending" &&
        inst.delegatedRegistration === null &&
        !parents.has(id)
      ) {
        this.activeSubagents.delete(id);
      }
    }
  }

  private getHost(): SubagentHost {
    return this.host ?? (this.host = new PiSubagentHost(this.cfg));
  }

  /**
   * Bundle coordinator-owned execution dependencies. Pi infrastructure is
   * deployment-lifetime state inside `SubagentHost`; each invocation gets its
   * own memory store and tool closures here.
   */
  private startInstance(instance: SubagentInstance): void {
    instance.settlementStarted = true;
    void this.executionDeps().then(
      (deps) => {
        void runInstance(instance, deps).then(
          (text) => {
            instance.resolveResult(text);
            instance.resolveSettlement();
          },
          (err: unknown) => {
            instance.rejectResult(err);
            instance.rejectSettlement(err);
          },
        );
      },
      (err: unknown) => {
        void this.failStartup(instance, err).then(
          () => {
            const failure = new Error("Subagent startup ended without a terminal failure");
            instance.rejectResult(failure);
            instance.rejectSettlement(failure);
          },
          (failure: unknown) => {
            instance.rejectResult(failure);
            instance.rejectSettlement(failure);
          },
        );
      },
    );
  }

  private async failStartup(instance: SubagentInstance, err: unknown): Promise<never> {
    const failures: unknown[] = [err];
    await this.stopAndCollect(instance, failures);
    const failure = combineFailures(failures, "Subagent startup failed") ?? err;

    if (instance.status === "running") {
      try {
        markErrored(instance, this.delegatedWorkHost, failure);
      } catch (terminalError) {
        throw combineFailures([failure, terminalError], "Subagent startup transition failed") ?? terminalError;
      }
    }
    throw failure;
  }

  private async executionDeps(): Promise<ExecutionDeps> {
    const memoryStore = this.memoryStoreFactory(this.cfg.goblinHome, this.embeddingProvider);
    return {
      buildTools: (depth, sessionId, parentCapture, inheritance, onStatusUpdate, delegatedContext, parentSubagentId) =>
        this.toolFactory
          ? this.toolFactory(
            this,
            depth,
            sessionId,
            parentCapture,
            inheritance,
            onStatusUpdate,
            delegatedContext,
            parentSubagentId,
          )
          : [],
      memoryStore,
      delegatedWorkHost: this.delegatedWorkHost,
    };
  }
}

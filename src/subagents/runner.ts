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

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { boundedError, log } from "../log.ts";
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
import { environmentCwd } from "../sessions/environment.ts";
import { topicScopeDir } from "../memory/paths.ts";
import {
  type ExecutionDeps,
  markErrored,
  prefixStatusCallback,
  runInstance,
  teardownInstance,
} from "./execution.ts";
import {
  assertSafeSubagentId,
  findSessionFile,
  loadSubagentMeta,
  persistMetaPatch,
  writeMetaAtomic,
} from "./meta.ts";
import { loadNamedAgent, NamedAgentNotFoundError } from "./named-agents.ts";
import { VALID_NAME_RE } from "./validation.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
} from "./paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type GenericSubagentInheritance,
  type NamedAgentDefinition,
  type SpawnOptions,
  type SubagentHandle,
  type SubagentInfo,
  type SubagentInstance,
  type SubagentMeta,
  type SubagentRole,
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
) => SubagentInvocation["customTools"];

export type SubagentMemoryStoreFactory = (
  home: string,
  embeddingProvider?: EmbeddingProvider,
) => MemoryStore;

function genericExecutionCwd(
  inheritance: GenericSubagentInheritance | null,
  home: string,
): string {
  if (inheritance === null) {
    throw new Error("generic subagent requires inherited execution authority");
  }
  return environmentCwd(inheritance.executionEnvironment, home);
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
  return {
    cwd,
    history,
    resource: {
      kind: "generic",
      skillPaths: inheritance.resolvedSkills.skills.map((skill) => skill.filePath),
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

  constructor(
    cfg: Config,
    toolFactory?: SubagentToolFactory,
    embeddingProvider?: EmbeddingProvider,
    host?: SubagentHost,
    memoryStoreFactory?: SubagentMemoryStoreFactory,
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
  }

  /**
   * Spawn a new subagent and kick off its first turn.
   *
   * Generic (no `name`): creates `$GOBLIN_HOME/scratch/subagents/<id>/`,
   * persists a pi session, and inherits the caller's Execution Environment
   * plus frozen resolved skill manifest (exact files, no re-discovery).
   *
   * Named (`name` provided): loads
   * `$GOBLIN_HOME/workspace/agents/<name>/AGENTS.md` (required), creates an
   * `instances/<id>/` child for persistence, and builds a
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
    const spawnedBy = options.spawnedBy ?? null;
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
    let dir: string;
    let metaPath: string;
    let definition: NamedAgentDefinition | null;
    let displayName: string | null;
    let inheritance: GenericSubagentInheritance | null;

    if (options.name !== undefined) {
      role = "named";
      definition = loadNamedAgent(this.cfg.goblinHome, options.name);
      displayName = options.name;
      inheritance = null;
      dir = namedAgentInstanceDir(this.cfg.goblinHome, options.name, id);
      metaPath = namedAgentInstanceMetaPath(this.cfg.goblinHome, options.name, id);
    } else {
      role = "generic";
      definition = null;
      displayName = null;
      inheritance = options.inheritance;
      dir = genericSubagentDir(this.cfg.goblinHome, id);
      metaPath = genericSubagentMetaPath(this.cfg.goblinHome, id);
    }

    // Create the instance directory up-front so meta.json + history
    // file land side-by-side.
    mkdirSync(dir, { recursive: true });

    // Prepare the execution CWD before creating the authoritative running
    // record. The Pi host prepares the exact new history target; model
    // activation remains deferred until the lease is run.
    const cwd =
      role === "named"
        ? namedAgentDir(this.cfg.goblinHome, options.name as string)
        : genericExecutionCwd(inheritance, this.cfg.goblinHome);
    const history = { kind: "create" as const, sessionDir: dir };
    const preparedExecution = this.getHost().prepare(
      preparationFor(cwd, history, role, definition, inheritance),
    );

    const meta: SubagentMeta = {
      id,
      role,
      name: displayName,
      spawnedBy,
      activeScope: authority.activeScope,
      depth: newDepth,
      createdAt: spawnedAt,
      status: "running",
    };
    try {
      writeMetaAtomic(metaPath, meta);
    } catch (err) {
      let stopFailure: unknown;
      try {
        await stopPreparedExecution(preparedExecution, id);
      } catch (cleanupError) {
        stopFailure = cleanupError;
      }
      throw combineFailures([err, stopFailure].filter((value) => value !== undefined), "Subagent spawn cleanup failed") ?? err;
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
      dir,
      metaPath,
      history,
      initialPrompt: options.prompt,
      onStatusUpdate: prefixStatusCallback(displayName ?? id.slice(0, 8), options.onStatusUpdate),
      // Store raw callback for nested spawning (prevents prefix stacking)
      rawStatusCallback: options.onStatusUpdate,
      definition,
      inheritance,
      execution: preparedExecution,
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
  ): Promise<string> {
    if (this.disposed) {
      throw new Error("SubagentRunner is disposed");
    }

    // The id enters filesystem path construction below and may originate from
    // a model tool call. Reject traversal and malformed segments first.
    assertSafeSubagentId(id);

    // Guard against concurrent revive() of the same subagent ID.
    if (this.revivesInProgress.has(id)) {
      throw new Error("Subagent revive already in progress");
    }

    // Reject if this subagent is already active and running.
    const existing = this.activeSubagents.get(id);
    if (existing !== undefined && existing.status === "running") {
      throw new Error("Subagent is already running");
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

    // Locate meta.json: could be generic or named. Scan both trees.
    let dir: string;
    let meta: SubagentMeta;
    try {
      const metaResult = loadSubagentMeta(this.cfg.goblinHome, id);
      dir = metaResult.dir;
      meta = metaResult.meta;
    } catch (err) {
      this.revivesInProgress.delete(id);
      throw err;
    }

    // A generic revival without the reviving runtime's environment/manifest
    // authority would either run under the wrong CWD or re-run discovery.
    // Both violate decision 0034 and the execution-environment contract.
    if (meta.role === "generic" && inheritance === null) {
      this.revivesInProgress.delete(id);
      throw new Error(
        `Generic subagent '${id}' revival requires the reviving runtime's resolved skill manifest and execution environment`,
      );
    }

    // Find the persisted session file inside the subagent's dir.
    const sessionFile = findSessionFile(dir);
    if (sessionFile === null) {
      this.revivesInProgress.delete(id);
      throw new Error(`Subagent not found`);
    }

    // Revival is a new invocation: it inherits the reviving parent runtime's
    // captured Surface authority. The persisted legacy activeScope is audit-only.
    const authority = parentCapture.authority;
    const caller: SurfaceMemoryCaller =
      meta.role === "named" && meta.name !== null
        ? { kind: "named-subagent", name: meta.name }
        : { kind: "anonymous-subagent" };

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
      meta.role === "named" && meta.name !== null
        ? namedAgentDir(this.cfg.goblinHome, meta.name)
        : genericExecutionCwd(inheritance, this.cfg.goblinHome);

    // Preserve the exact lexical history target selected by meta.ts. The Pi
    // host opens exactly this file and does not rediscover a latest history.
    const history = { kind: "open" as const, sessionDir: dir, sessionFile };

    // Rebuild the named-agent definition if the subagent is named.
    let definition: NamedAgentDefinition | null = null;
    if (meta.role === "named" && meta.name !== null) {
      try {
        definition = loadNamedAgent(this.cfg.goblinHome, meta.name);
      } catch (err) {
        this.revivesInProgress.delete(id);
        if (err instanceof NamedAgentNotFoundError) {
          throw new Error(`Named agent '${meta.name}' definition missing; cannot revive`);
        }
        throw err;
      }
    }

    let preparedExecution: SubagentExecution;
    try {
      preparedExecution = this.getHost().prepare(
        preparationFor(
          cwd,
          history,
          meta.role,
          definition,
          meta.role === "generic" ? inheritance : null,
        ),
      );
    } catch (err) {
      this.revivesInProgress.delete(id);
      throw err;
    }

    // Install both public and internal settlement before attachment can race
    // cancellation or startup.
    const result = deferred<string>();
    const settlement = deferred<void>();

    const instance: SubagentInstance = {
      id,
      name: meta.name ?? null,
      role: meta.role,
      status: "running",
      authority,
      caller,
      depth: meta.depth,
      spawnedAt: meta.createdAt,
      spawnedBy: meta.spawnedBy ?? null,
      dir,
      metaPath: join(dir, "meta.json"),
      history,
      initialPrompt: prompt,
      onStatusUpdate: prefixStatusCallback(meta.name ?? id.slice(0, 8), onStatusUpdate),
      // Store raw callback for nested spawning (prevents prefix stacking)
      rawStatusCallback: onStatusUpdate,
      definition,
      inheritance: meta.role === "generic" ? inheritance : null,
      execution: preparedExecution,
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

    // Update meta to reflect the revival — clear stale terminal fields.
    // A failed durable transition must stop revival rather than launching a
    // run whose on-disk record still claims the prior terminal state.
    try {
      persistMetaPatch(instance, { status: "running", completedAt: undefined, errorMessage: undefined });
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
      throw failure;
    }

    log.debug("subagent revived", { id, role: meta.role, name: meta.name });

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
   * Snapshot of all known subagent instances.
   */
  list(): SubagentInfo[] {
    const out: SubagentInfo[] = [];
    for (const inst of this.activeSubagents.values()) {
      out.push({
        id: inst.id,
        name: inst.name,
        role: inst.role,
        status: inst.status,
        spawnedAt: inst.spawnedAt,
        spawnedBy: inst.spawnedBy,
      });
    }
    return out;
  }

  /**
   * Cancel an active subagent. The runner owns the policy and metadata
   * transition; the host receives only the Pi stop mechanism.
   */
  async cancel(id: string): Promise<void> {
    const instance = this.activeSubagents.get(id);
    if (instance === undefined) {
      throw new Error("Subagent not found");
    }
    if (instance.status !== "running") return;

    // A host success reservation wins over cancellation, but the operation
    // still waits for final cleanup/metadata outcome so it cannot report a
    // false quiescent success.
    if (instance.completionClaimed) {
      try {
        await waitWithTimeout(instance.result, CANCEL_COMPLETION_TIMEOUT_MS, () =>
          new Error("Subagent completion wait timed out during cancel"));
      } catch (err) {
        const failure = combineFailures([err], "Subagent cancellation failed");
        if (failure !== null) throw failure;
      }
      return;
    }

    // Claim cancellation synchronously so a terminal Pi event cannot win
    // after this point. Capture the lease before awaiting; no coordinator
    // path may replace it after the lifecycle claim.
    instance.status = "cancelled";
    instance.rejectResult(new Error("Subagent was cancelled"));
    const failures: unknown[] = [];
    await this.stopAndCollect(instance, failures, "subagent execution stop failed during cancel");

    try {
      persistMetaPatch(instance, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      failures.push(err);
      log.error("cancel persistMeta failed — disk state may be stale", {
        id,
        ...boundedError(err),
      });
    }

    if (instance.settlementStarted) await collectSettlement(instance, failures);
    else instance.resolveSettlement();
    teardownInstance(instance);
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
      }),
      ...targets.map(async (instance) => {
        await this.stopAndCollect(instance, failures, "cancelBySession execution stop failed");

        try {
          persistMetaPatch(instance, {
            status: "cancelled",
            completedAt: new Date().toISOString(),
          });
        } catch (err) {
          failures.push(err);
          log.error("cancelBySession persistMeta failed", {
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
            persistMetaPatch(instance, {
              status: "cancelled",
              completedAt: new Date().toISOString(),
            });
          } catch (err) {
            failures.push(err);
            log.error("dispose persistMeta failed", {
              id,
              ...boundedError(err),
            });
          }
          if (instance.settlementStarted) await collectSettlement(instance, failures);
          else instance.resolveSettlement();
        } else if (instance.status === "cancelled") {
          if (instance.settlementStarted) await collectSettlement(instance, failures);
          else instance.resolveSettlement();
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
      if (inst.status !== "running" && !parents.has(id)) {
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
        markErrored(instance, failure);
      } catch (terminalError) {
        throw combineFailures([failure, terminalError], "Subagent startup transition failed") ?? terminalError;
      }
    }
    throw failure;
  }

  private async executionDeps(): Promise<ExecutionDeps> {
    const memoryStore = this.memoryStoreFactory(this.cfg.goblinHome, this.embeddingProvider);
    return {
      buildTools: (depth, sessionId, parentCapture, inheritance, onStatusUpdate) =>
        this.toolFactory
          ? this.toolFactory(this, depth, sessionId, parentCapture, inheritance, onStatusUpdate)
          : [],
      memoryStore,
    };
  }
}

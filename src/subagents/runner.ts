/**
 * `SubagentRunner` — lifecycle orchestrator for subagents spawned by goblin
 * (or by another subagent).
 *
 * Owns:
 *   - the in-memory map of active instances (keyed by id)
 *   - lazy initialisation of the shared pi services
 *   - concurrency guards (disposed flag, in-flight revive set)
 *   - the public surface: `spawn`, `revive`, `cancel`, `list`, `dispose`
 *
 * Does NOT own (delegated to siblings):
 *   - persistence → `meta.ts`
 *   - named-agent loading + ResourceLoader construction → `named-agents.ts`
 *   - the run-to-completion engine → `execution.ts`
 *
 * Current behavior is exercised by `mod.test.ts` and `test/*.suite.ts`.
 * Historical design: `specs/changes/archive/2026-04-26-subagent-runtime/`.
 */

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { boundedError, log } from "../log.ts";
import {
  MemoryStore,
  EmbeddingProvider,
  type CapturedMemoryContext,
  type SurfaceMemoryCaller,
} from "../memory/mod.ts";
import { createPiServices, type PiServices } from "../pi-host.ts";
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
import {
  loadNamedAgent,
  NamedAgentNotFoundError,
  VALID_NAME_RE,
} from "./named-agents.ts";
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
) => ToolDefinition[];

function genericExecutionCwd(
  inheritance: GenericSubagentInheritance | null,
  home: string,
): string {
  if (inheritance === null) {
    throw new Error("generic subagent requires inherited execution authority");
  }
  return environmentCwd(inheritance.executionEnvironment, home);
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
  private services: PiServices | null = null;
  /** Produces tools (e.g. spawn_subagent) injected into each spawned subagent. */
  private readonly toolFactory: SubagentToolFactory | null;
  /** Shared embedding provider for memory stores created per subagent run. */
  private readonly embeddingProvider?: EmbeddingProvider;
  /** Prevents new spawns after dispose(). */
  private disposed = false;
  /** Guards against concurrent revive() of the same subagent ID. */
  private readonly revivesInProgress: Set<string> = new Set();

  constructor(cfg: Config, toolFactory?: SubagentToolFactory, embeddingProvider?: EmbeddingProvider) {
    this.cfg = cfg;
    this.goblinHome = cfg.goblinHome;
    this.toolFactory = toolFactory ?? null;
    this.embeddingProvider = embeddingProvider;
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
   * `DefaultResourceLoader` that uses the AGENTS.md content as the system
   * prompt and pins skill discovery to the agent's own `.agents/skills/`
   * catalog — strictly isolated from Goblin and caller skills.
   *
   * Returns immediately with a handle; `handle.result` resolves when the
   * subagent's `agent_end` event fires (or rejects on error).
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

    // Create the instance directory up-front so meta.json + pi's session
    // file land side-by-side.
    mkdirSync(dir, { recursive: true });

    // Prepare the execution CWD and persisted session manager before creating
    // the authoritative running record. A setup failure may leave an empty
    // directory, but it must not leave metadata claiming a runnable instance.
    const cwd =
      role === "named"
        ? namedAgentDir(this.cfg.goblinHome, options.name as string)
        : genericExecutionCwd(inheritance, this.cfg.goblinHome);
    const sessionManager = SessionManager.create(cwd, dir);

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
    writeMetaAtomic(metaPath, meta);

    // The result promise is wired during runInstance; capture the resolver
    // pair here so the instance carries it before execution kicks off.
    let resolveResult!: (text: string) => void;
    let rejectResult!: (err: unknown) => void;
    const result = new Promise<string>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

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
      sessionManager,
      initialPrompt: options.prompt,
      onStatusUpdate: prefixStatusCallback(displayName ?? id.slice(0, 8), options.onStatusUpdate),
      // Store raw callback for nested spawning (prevents prefix stacking)
      rawStatusCallback: options.onStatusUpdate,
      definition,
      inheritance,
      session: null,
      unsubscribe: null,
      result,
      resolveResult,
      rejectResult,
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
    this.executionDeps()
      .catch((err) => {
        markErrored(instance, err);
        throw err;
      })
      .then(
        (deps) =>
          runInstance(instance, cwd, deps).then(
            (text) => resolveResult(text),
            (err) => rejectResult(err),
          ),
        rejectResult,
      );

    // Attach a noop catch to prevent unhandled-rejection noise when callers
    // delay observing `result` (e.g. polling via `list()` first). The
    // rejection is still observable by any later `.catch` / `await`.
    result.catch(() => {});

    return { id, status: "running", result };
  }

  /**
   * Resume a persisted subagent and send it a follow-up prompt.
   *
   * Loads the subagent's `meta.json` to locate its session directory, opens
   * the existing `.jsonl` session file via pi's `SessionManager.open()`,
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

    // Open the existing session so conversation history is preserved.
    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.open(sessionFile, dir, cwd);
    } catch (err) {
      this.revivesInProgress.delete(id);
      throw err;
    }

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

    // Wire result promise the same way spawn() does.
    let resolveResult!: (text: string) => void;
    let rejectResult!: (err: unknown) => void;
    const result = new Promise<string>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    // Attach before any await below: cancellation during attachment may reject
    // the result before the execution pipeline is started.
    result.catch(() => {});

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
      sessionManager,
      initialPrompt: prompt,
      onStatusUpdate: prefixStatusCallback(meta.name ?? id.slice(0, 8), onStatusUpdate),
      // Store raw callback for nested spawning (prevents prefix stacking)
      rawStatusCallback: onStatusUpdate,
      definition,
      inheritance: meta.role === "generic" ? inheritance : null,
      session: null,
      unsubscribe: null,
      result,
      resolveResult,
      rejectResult,
    };
    this.activeSubagents.set(id, instance);
    if (onAttached) {
      try {
        await onAttached();
      } catch (err) {
        this.activeSubagents.delete(id);
        this.revivesInProgress.delete(id);
        rejectResult(err);
        throw err;
      }
    }

    // Cancellation can run while an asynchronous attachment callback yields.
    // It owns the terminal state, so do not resurrect this instance on disk or
    // launch a fresh execution after it has been cancelled.
    if (instance.status !== "running") {
      const completed = result.finally(() => {
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
      rejectResult(err);
      throw err;
    }

    log.debug("subagent revived", { id, role: meta.role, name: meta.name });

    // Kick off execution — same pipeline as spawn().
    this.executionDeps()
      .catch((err) => {
        markErrored(instance, err);
        throw err;
      })
      .then(
        (deps) =>
          runInstance(instance, cwd, deps).then(
            (text) => resolveResult(text),
            (err) => rejectResult(err),
          ),
        rejectResult,
      );
    // Resolve the revive only after its bookkeeping (revivesInProgress) is
    // cleared, so a subsequent revive() of the same id observes a clean
    // slate. (The await in callers thus sees the guard already removed.)
    const completed = result.finally(() => {
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
   * Cancel an active subagent.
   *
   * Calls `session.abort()` on the underlying `AgentSession` and marks the
   * subagent as cancelled in both in-memory state and `meta.json`.
   *
   * Throws "Subagent not found" if the id is not in the active map.
   * No-op if the subagent is already in a terminal state.
   */
  async cancel(id: string): Promise<void> {
    const instance = this.activeSubagents.get(id);
    if (instance === undefined) {
      throw new Error("Subagent not found");
    }

    // No-op on terminal states — don't overwrite the audit trail.
    // Synchronous check + set prevents double-cancel races.
    if (instance.status !== "running") {
      return;
    }
    // Mark cancelled synchronously before any await so concurrent
    // cancel() calls see a non-running status and exit early.
    instance.status = "cancelled";
    instance.rejectResult(new Error("Subagent was cancelled"));

    // Capture session/unsubscribe before any await so a concurrent runInstance
    // cannot reassign them mid-cleanup.
    const session = instance.session;
    const unsubscribe = instance.unsubscribe;
    let persistenceFailed = false;
    let persistenceError: unknown;

    try {
      if (session !== null) {
        try {
          await session.abort();
        } catch {
          // abort() may throw if the session is in a bad state.
          // We still want to update status and clean up.
          log.debug("session.abort() threw during cancel", { id, error: "(swallowed)" });
        }
      }

      try {
        persistMetaPatch(instance, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        persistenceFailed = true;
        persistenceError = err;
        log.error("cancel persistMeta failed — disk state may be stale", {
          id,
          ...boundedError(err),
        });
      }

      try {
        unsubscribe?.();
      } catch {
        // best-effort
      } finally {
        instance.unsubscribe = null;
      }

      try {
        teardownInstance(instance);
      } catch (err) {
        log.error("cancel teardown failed", { id, ...boundedError(err) });
      }
    } catch (err) {
      // teardown failed — still try to clean up.
      try {
        unsubscribe?.();
      } catch {
        // best-effort
      }
      instance.unsubscribe = null;
      instance.session = null;
      log.error("cancel cleanup failed", { id, ...boundedError(err) });
    }

    log.debug("subagent cancelled", { id });
    if (persistenceFailed) {
      throw persistenceError;
    }
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

    // 2. Mark every non-terminal instance as cancelled synchronously before any await.
    const targets: SubagentInstance[] = [];
    for (const id of queue) {
      const instance = this.activeSubagents.get(id);
      if (instance !== undefined && instance.status === "running") {
        instance.status = "cancelled";
        instance.rejectResult(new Error("Subagent was cancelled"));
        targets.push(instance);
      }
    }

    // 3. Clean up each targeted instance concurrently. Start all aborts in
    //    parallel so a parent that is blocked on a child result can be
    //    unblocked when the child's abort settles.
    const persistenceFailures: unknown[] = [];
    await Promise.all(
      targets.map(async (instance) => {
        // Capture session/unsubscribe before any await so a concurrent runInstance
        // cannot reassign them mid-cleanup.
        const session = instance.session;
        const unsubscribe = instance.unsubscribe;

        if (session !== null) {
          try {
            await session.abort();
          } catch {
            // abort() may throw if the session is in a bad state.
            // We still want to persist and clean up.
          }
        }

        try {
          persistMetaPatch(instance, {
            status: "cancelled",
            completedAt: new Date().toISOString(),
          });
        } catch (err) {
          persistenceFailures.push(err);
          log.error("cancelBySession persistMeta failed", {
            id: instance.id,
            ...boundedError(err),
          });
        }

        try {
          unsubscribe?.();
        } catch {
          // best-effort
        } finally {
          instance.unsubscribe = null;
        }

        try {
          teardownInstance(instance);
        } catch (err) {
          log.error("cancelBySession teardown failed", {
            id: instance.id,
            ...boundedError(err),
          });
        }
      }),
    );

    if (targets.length > 0) {
      log.debug("cascade-cancel: subagents cancelled", {
        count: targets.length,
        sessionId,
      });
    }
    if (persistenceFailures.length > 0) {
      throw persistenceFailures[0];
    }
  }

  /**
   * Gracefully shut down all active subagents.
   * Aborts running ones, disposes their sessions, and clears the map.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...this.activeSubagents.keys()];
    const persistenceFailures: unknown[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const instance = this.activeSubagents.get(id);
        if (!instance) return;
        // Only cancel instances that are still running. Completed/errored/
        // cancelled instances should keep their existing status — don't
        // overwrite a successful completion with "cancelled".
        if (instance.status === "running") {
          // Mark cancelled before any await so a concurrent runInstance sees
          // the non-running status and does not start/assign a new session.
          instance.status = "cancelled";
          instance.rejectResult(new Error("Subagent was cancelled"));
          // Capture session/unsubscribe before any await so a concurrent
          // runInstance cannot reassign them mid-cleanup.
          const session = instance.session;
          const unsubscribe = instance.unsubscribe;
          try {
            if (session !== null) {
              await session.abort();
            }
          } catch {
            /* best-effort */
          }
          try {
            unsubscribe?.();
          } catch {
            /* best-effort */
          } finally {
            instance.unsubscribe = null;
          }
          try {
            persistMetaPatch(instance, {
              status: "cancelled",
              completedAt: new Date().toISOString(),
            });
          } catch (err) {
            persistenceFailures.push(err);
            log.error("dispose persistMeta failed", {
              id,
              ...boundedError(err),
            });
          }
        }
        try {
          teardownInstance(instance);
        } catch (err) {
          log.error("dispose teardown failed", {
            id,
            ...boundedError(err),
          });
        }
      }),
    );
    this.activeSubagents.clear();
    log.debug("SubagentRunner disposed", { count: ids.length });
    if (persistenceFailures.length > 0) {
      throw persistenceFailures[0];
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

  /**
   * Lazily create the shared pi services (auth, model registry, settings).
   * All subagents within a `SubagentRunner` share these — only the
   * `SessionManager` is per-subagent so each has its own conversation file.
   *
   * Lazy-init is safe without synchronization because Node.js' single-
   * threaded event loop serializes code between async ticks.
   */
  private async getPiServices(): Promise<PiServices> {
    return (this.services ??= await createPiServices(this.cfg.goblinHome));
  }

  /**
   * Bundle the dependencies execution.ts needs. Per-call so the toolFactory
   * always sees the current `this`.
   */
  private async executionDeps(): Promise<ExecutionDeps> {
    const services = await this.getPiServices();
    const memoryStore = this.embeddingProvider
      ? new MemoryStore(this.cfg.goblinHome, undefined, { embeddings: this.embeddingProvider })
      : new MemoryStore(this.cfg.goblinHome);
    return {
      cfg: this.cfg,
      services,
      buildTools: (depth, sessionId, parentCapture, inheritance, onStatusUpdate) =>
        this.toolFactory ? this.toolFactory(this, depth, sessionId, parentCapture, inheritance, onStatusUpdate) : [],
      memoryStore,
    };
  }
}

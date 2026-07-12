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
 * See specs/canon/subagents/spec.md for behavioural requirements.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { memoryDir, type ActiveScope } from "../memory/mod.ts";
import { createPiServices, type PiServices } from "../pi-host.ts";
import { workdirPath } from "../workspace/paths.ts";
import {
  type ExecutionDeps,
  prefixStatusCallback,
  runInstance,
  teardownInstance,
} from "./execution.ts";
import { findSessionFile, loadSubagentMeta, persistMetaPatch, writeMetaAtomic } from "./meta.ts";
import { loadNamedAgent, VALID_NAME_RE } from "./named-agents.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
} from "./paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type NamedAgentDefinition,
  type SpawnOptions,
  type SubagentHandle,
  type SubagentInfo,
  type SubagentInstance,
  type SubagentMeta,
  type SubagentRole,
} from "./types.ts";

/** Factory that produces tools to inject into spawned subagents. */
export type SubagentToolFactory = (
  runner: SubagentRunner,
  depth: number,
  sessionId: string,
  activeScope: ActiveScope,
  onStatusUpdate?: (message: string) => void,
) => ToolDefinition[];

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
  /** Prevents new spawns after dispose(). */
  private disposed = false;
  /** Guards against concurrent revive() of the same subagent ID. */
  private readonly revivesInProgress: Set<string> = new Set();

  constructor(cfg: Config, toolFactory?: SubagentToolFactory) {
    this.cfg = cfg;
    this.goblinHome = cfg.goblinHome;
    this.toolFactory = toolFactory ?? null;
  }

  /**
   * Spawn a new subagent and kick off its first turn.
   *
   * Generic (no `name`): creates `~/goblin/subagents/<id>/`, persisted pi
   * session, inherits goblin's project context (cwd = workdir).
   *
   * Named (`name` provided): loads `~/goblin/agents/<name>/AGENTS.md` (must
   * exist), creates `~/goblin/agents/<name>/instances/<id>/` for persistence,
   * builds a `DefaultResourceLoader` that uses the AGENTS.md content as the
   * system prompt and pins skill discovery to the agent's own `skills/`
   * directory — strictly isolated from goblin.
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
    const activeScope = childActiveScope(options.activeScope, options.name);

    let role: SubagentRole;
    let dir: string;
    let metaPath: string;
    let definition: NamedAgentDefinition | null;
    let displayName: string | null;

    if (options.name !== undefined) {
      role = "named";
      definition = loadNamedAgent(this.cfg.goblinHome, options.name);
      displayName = options.name;
      dir = namedAgentInstanceDir(this.cfg.goblinHome, options.name, id);
      metaPath = namedAgentInstanceMetaPath(this.cfg.goblinHome, options.name, id);
    } else {
      role = "generic";
      definition = null;
      displayName = null;
      dir = genericSubagentDir(this.cfg.goblinHome, id);
      metaPath = genericSubagentMetaPath(this.cfg.goblinHome, id);
    }

    // Create the instance directory up-front so meta.json + pi's session
    // file land side-by-side.
    mkdirSync(dir, { recursive: true });

    const meta: SubagentMeta = {
      id,
      role,
      name: displayName,
      spawnedBy,
      activeScope,
      depth: newDepth,
      createdAt: spawnedAt,
      status: "running",
    };
    writeMetaAtomic(metaPath, meta);

    // Persisted session lives in the subagent's own directory.
    // cwd: generic → goblin's workdir (inherits goblin's project context);
    //      named   → the named agent's root dir (so the resource loader
    //                discovers nothing outside the agent's tree).
    const cwd =
      role === "named"
        ? namedAgentDir(this.cfg.goblinHome, options.name as string)
        : workdirPath(this.cfg.goblinHome);
    const sessionManager = SessionManager.create(cwd, dir);

    // The result promise is wired during runInstance; capture the resolver
    // pair here so the instance carries it before execution kicks off.
    let resolveResult: (text: string) => void;
    let rejectResult: (err: unknown) => void;
    const result = new Promise<string>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const instance: SubagentInstance = {
      id,
      name: displayName,
      role,
      status: "running",
      activeScope,
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
      session: null,
      unsubscribe: null,
      result,
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
    runInstance(instance, cwd, this.executionDeps()).then(
      (text) => resolveResult(text),
      (err) => rejectResult(err),
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
   * Throws "Subagent not found" if no `meta.json` exists for the given id.
   */
  async revive(id: string, prompt: string, onStatusUpdate?: (message: string) => void): Promise<string> {
    if (this.disposed) {
      throw new Error("SubagentRunner is disposed");
    }

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

    // Locate meta.json: could be generic or named. Scan both trees.
    const { dir, meta } = loadSubagentMeta(this.cfg.goblinHome, id);

    // Find the persisted session file inside the subagent's dir.
    const sessionFile = findSessionFile(dir);
    if (sessionFile === null) {
      throw new Error(`Subagent not found`);
    }

    // Validate that the topic directory exists if the subagent has a topic scope.
    // This catches cases where the topic was archived since the subagent was last run.
    if (meta.activeScope?.topicScope !== undefined && meta.activeScope.topicScope !== "general") {
      const chatId = meta.activeScope.chatId;
      const topicId = meta.activeScope.topicScope.topicId;
      const topicDir = join(memoryDir(this.cfg.goblinHome), "topics", String(chatId), String(topicId));
      if (!existsSync(topicDir)) {
        this.revivesInProgress.delete(id);
        throw new Error(
          `Subagent '${id}' topic scope (${chatId}/${topicId}) no longer exists; cannot revive`,
        );
      }
    }

    // Determine cwd the same way spawn() does.
    const cwd =
      meta.role === "named" && meta.name !== null
        ? namedAgentDir(this.cfg.goblinHome, meta.name)
        : workdirPath(this.cfg.goblinHome);

    // Open the existing session so conversation history is preserved.
    const sessionManager = SessionManager.open(sessionFile, dir, cwd);

    // Rebuild the named-agent definition if the subagent is named.
    let definition: NamedAgentDefinition | null = null;
    if (meta.role === "named" && meta.name !== null) {
      try {
        definition = loadNamedAgent(this.cfg.goblinHome, meta.name);
      } catch {
        this.revivesInProgress.delete(id);
        throw new Error(`Named agent '${meta.name}' definition missing; cannot revive`);
      }
    }

    // Wire result promise the same way spawn() does.
    let resolveResult: (text: string) => void;
    let rejectResult: (err: unknown) => void;
    const result = new Promise<string>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const instance: SubagentInstance = {
      id,
      name: meta.name ?? null,
      role: meta.role,
      status: "running",
      activeScope: reviveActiveScope(meta),
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
      session: null,
      unsubscribe: null,
      result,
    };
    this.activeSubagents.set(id, instance);

    // Update meta to reflect the revival — clear stale terminal fields.
    // Best-effort: stale meta is cosmetic; the session file is the
    // source of truth for revival.
    try {
      persistMetaPatch(instance, { status: "running", completedAt: undefined, errorMessage: undefined });
    } catch (err) {
      log.warn("failed to persist revive meta", { id, err: err instanceof Error ? err.message : String(err) });
    }

    log.debug("subagent revived", { id, role: meta.role, name: meta.name });

    // Kick off execution — same pipeline as spawn().
    runInstance(instance, cwd, this.executionDeps()).then(
      (text) => resolveResult(text),
      (err) => rejectResult(err),
    ).finally(() => {
      this.revivesInProgress.delete(id);
    });
    result.catch(() => {});

    return result;
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

    // Capture session/unsubscribe before any await so a concurrent runInstance
    // cannot reassign them mid-cleanup.
    const session = instance.session;
    const unsubscribe = instance.unsubscribe;

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
        log.error("cancel persistMeta failed — disk state may be stale", {
          id,
          err: err instanceof Error ? err.message : String(err),
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
        log.error("cancel teardown failed", { id, err: err instanceof Error ? err.message : String(err) });
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
      log.error("cancel cleanup failed", { id, err: err instanceof Error ? err.message : String(err) });
    }

    log.debug("subagent cancelled", { id });
  }

  /**
   * Cancel every subagent in the spawn tree rooted at the given session id.
   *
   * Walks `spawnedBy` parentage, marks all non-terminal instances as
   * `cancelled` synchronously before any await, then tears them down. The
   * method never rejects — per-instance errors are logged and swallowed.
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
        targets.push(instance);
      }
    }

    // 3. Clean up each targeted instance concurrently. Start all aborts in
    //    parallel so a parent that is blocked on a child result can be
    //    unblocked when the child's abort settles.
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
          log.error("cancelBySession persistMeta failed", {
            id: instance.id,
            err: err instanceof Error ? err.message : String(err),
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
            err: err instanceof Error ? err.message : String(err),
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
  }

  /**
   * Gracefully shut down all active subagents.
   * Aborts running ones, disposes their sessions, and clears the map.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...this.activeSubagents.keys()];
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
            log.error("dispose persistMeta failed", {
              id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          teardownInstance(instance);
        } catch (err) {
          log.error("dispose teardown failed", {
            id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    this.activeSubagents.clear();
    log.debug("SubagentRunner disposed", { count: ids.length });
  }

  /**
   * Remove terminal instances from the map to bound memory growth.
   * Called lazily on each `spawn()`.
   */
  private pruneTerminal(): void {
    for (const [id, inst] of this.activeSubagents) {
      if (inst.status !== "running") {
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
  private getPiServices(): PiServices {
    return (this.services ??= createPiServices(this.cfg.goblinHome));
  }

  /**
   * Bundle the dependencies execution.ts needs. Per-call so the toolFactory
   * always sees the current `this`.
   */
  private executionDeps(): ExecutionDeps {
    return {
      cfg: this.cfg,
      services: this.getPiServices(),
      buildTools: (depth, sessionId, activeScope, onStatusUpdate) =>
        this.toolFactory ? this.toolFactory(this, depth, sessionId, activeScope, onStatusUpdate) : [],
    };
  }
}

function childActiveScope(parentScope: ActiveScope | undefined, name: string | undefined): ActiveScope {
  if (parentScope === undefined) {
    throw new Error("activeScope is required for subagent spawning");
  }
  const topicScope = parentScope.topicScope;
  // Empty string is treated as undefined (no named agent)
  const effectiveName = name && name.length > 0 ? name : undefined;
  return {
    chatId: parentScope.chatId,
    topicScope,
    namedAgent: effectiveName === undefined ? null : { name: effectiveName },
  };
}

function reviveActiveScope(meta: SubagentMeta): ActiveScope {
  return {
    chatId: meta.activeScope.chatId,
    topicScope: meta.activeScope.topicScope,
    namedAgent: meta.role === "named" && meta.name !== null ? { name: meta.name } : null,
  };
}

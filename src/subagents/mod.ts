/**
 * Subagent runtime.
 *
 * `SubagentRunner` owns the lifecycle of subagent instances spawned by goblin
 * (or by another subagent). Phase 4 wires real LLM execution: each spawn
 * creates a pi `AgentSession`, sends the initial prompt, streams events back
 * to the spawner, captures the final assistant text, and persists lifecycle
 * transitions to `meta.json`.
 *
 * See specs/changes/subagent-runtime/ for the full design and tasks.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

/** Valid characters for a named agent: alphanumeric, hyphens, underscores. */
const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;
import type { Config } from "../config.ts";
import { piAgentDir, workdirPath } from "../agent/paths.ts";
import { resolveModel } from "../agent/models.ts";
import { log } from "../log.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentSkillsDir,
  namedAgentsRoot,
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

/** Lazily-initialised pi services shared across all subagents in this runner. */
interface SharedServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
}

/** Factory that produces tools to inject into spawned subagents. */
export type SubagentToolFactory = (
  runner: SubagentRunner,
  depth: number,
  sessionId: string,
  onStatusUpdate?: (message: string) => void,
) => ToolDefinition[];

/**
 * Manages all subagents spawned within a goblin process.
 *
 * Holds a map of active subagents keyed by id and exposes spawn/revive/list/
 * cancel as the public surface used by the `spawn_subagent` tool and by the
 * bot wiring.
 */
export class SubagentRunner {
  private readonly cfg: Config;
  private readonly activeSubagents: Map<string, SubagentInstance> = new Map();
  private services: SharedServices | null = null;
  /** Produces tools (e.g. spawn_subagent) injected into each spawned subagent. */
  private readonly toolFactory: SubagentToolFactory | null;

  constructor(cfg: Config, toolFactory?: SubagentToolFactory) {
    this.cfg = cfg;
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
    // Prune terminal subagents before creating new ones.
    this.pruneTerminal();

    const spawnerDepth = options.depth ?? 0;
    if (spawnerDepth < 0) {
      throw new Error(`Invalid depth: ${spawnerDepth}`);
    }
    const newDepth = spawnerDepth + 1;
    if (newDepth > MAX_SUBAGENT_DEPTH) {
      throw new Error(`Maximum subagent depth reached (${MAX_SUBAGENT_DEPTH})`);
    }

    // Sanitise name to prevent path traversal.
    if (options.name !== undefined && !VALID_NAME_RE.test(options.name)) {
      throw new Error(
        `Invalid agent name '${options.name}': must match ${VALID_NAME_RE.source}`,
      );
    }

    const id = randomUUID();
    const spawnedAt = new Date().toISOString();
    const spawnedBy = options.spawnedBy ?? null;

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

    // The result promise is wired during runAgent; capture the resolver
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
      depth: newDepth,
      spawnedAt,
      spawnedBy,
      dir,
      metaPath,
      sessionManager,
      initialPrompt: options.prompt,
      onStatusUpdate: prefixStatusCallback(displayName ?? id.slice(0, 8), options.onStatusUpdate),
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
    this.runAgent(instance, cwd).then(
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
   * Execute the subagent's first turn end-to-end.
   *
   * Constructs the AgentSession with goblin's shared pi services + the
   * subagent's own session manager, subscribes to events, sends the initial
   * prompt, and resolves with the accumulated assistant text on `agent_end`.
   */
  private async runAgent(instance: SubagentInstance, cwd: string): Promise<string> {
    try {
      return await this._runAgentInner(instance, cwd);
    } catch (err) {
      // Catch startup failures (resolveModel, createAgentSession, reload)
      // that would otherwise leave meta.json stuck in "running".
      if (instance.status === "running") {
        this.markErrored(instance, err);
      }
      throw err;
    }
  }

  private async _runAgentInner(instance: SubagentInstance, cwd: string): Promise<string> {
    const services = this.getSharedServices();
    const resolved = resolveModel(this.cfg);
    services.authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);

    // Named subagents get a custom resource loader with strict isolation:
    // - noContextFiles: don't auto-discover project AGENTS.md from cwd.
    // - systemPrompt: use the named agent's AGENTS.md verbatim.
    // - noSkills + additionalSkillPaths: load only the agent's own skills/.
    // Generic subagents use pi's defaults but explicitly pin
    // additionalSkillPaths to ~/goblin/skills/ so they always discover
    // goblin's skills regardless of pi's default traversal behaviour.
    let resourceLoader: ResourceLoader | undefined;
    if (instance.role === "named" && instance.definition !== null) {
      resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: piAgentDir(this.cfg.goblinHome),
        settingsManager: services.settingsManager,
        noContextFiles: true,
        noSkills: true,
        additionalSkillPaths: [instance.definition.skillsDir],
        systemPrompt: instance.definition.agentsMd,
      });
      await resourceLoader.reload();
    } else if (instance.role === "generic") {
      resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: piAgentDir(this.cfg.goblinHome),
        settingsManager: services.settingsManager,
        additionalSkillPaths: [join(this.cfg.goblinHome, "skills")],
      });
      await resourceLoader.reload();
    }

    const { session } = await createAgentSession({
      cwd,
      authStorage: services.authStorage,
      modelRegistry: services.modelRegistry,
      settingsManager: services.settingsManager,
      sessionManager: instance.sessionManager,
      model: resolved.model,
      // Subagents have no β tools — all UI flows through the parent's status
      // callback. See specs/.../subagents/spec.md "No beta tools for subagents".
      customTools: this.toolFactory
        ? this.toolFactory(this, instance.depth, instance.id, instance.onStatusUpdate)
        : [],
      ...(resourceLoader ? { resourceLoader } : {}),
    });
    instance.session = session;

    // Guard: if cancel() was called while we were setting up the session,
    // tear down immediately instead of sending the prompt.
    if (instance.status === "cancelled") {
      try { await session.abort(); } catch { /* best-effort */ }
      return "";
    }

    // Resolve on agent_end, reject on errors during the run.
    let finalText = "";
    let resolved_text: ((s: string) => void) | null = null;
    let rejected_err: ((e: unknown) => void) | null = null;
    const completion = new Promise<string>((res, rej) => {
      resolved_text = res;
      rejected_err = rej;
    });

    instance.unsubscribe = session.subscribe((event) => {
      try {
        this.handleEvent(instance, event, {
          onText: (delta) => {
            finalText += delta;
          },
          onEnd: () => {
            this.markCompleted(instance, finalText);
            resolved_text?.(finalText);
          },
          onError: (err) => {
            this.markErrored(instance, err);
            rejected_err?.(err);
          },
        });
      } catch (err) {
        log.error("subagent event handler threw", {
          id: instance.id,
          err: err instanceof Error ? err.message : String(err),
        });
        // Ensure the completion promise settles even if handleEvent or
        // persistMeta throws — otherwise the parent's tool call hangs forever.
        rejected_err?.(err);
      }
    });

    // Fire the initial prompt. If this throws (e.g. provider auth error
    // before any events stream), the outer .then in spawn() turns it into
    // a rejected `handle.result`.
    try {
      await session.sendUserMessage(instance.initialPrompt);
    } catch (err) {
      this.markErrored(instance, err);
      throw err;
    }

    return completion;
  }

  /**
   * Translate a single AgentSession event into status-callback updates
   * and lifecycle hooks. Centralised so the run loop stays linear.
   */
  private handleEvent(
    instance: SubagentInstance,
    event: AgentSessionEvent,
    hooks: {
      onText: (delta: string) => void;
      onEnd: () => void;
      onError: (err: unknown) => void;
    },
  ): void {
    switch (event.type) {
      case "agent_start":
        instance.onStatusUpdate?.("thinking...");
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          hooks.onText(ame.delta);
        }
        break;
      }

      case "tool_execution_start":
        instance.onStatusUpdate?.(`tool: ${event.toolName}`);
        break;

      case "tool_execution_end":
        instance.onStatusUpdate?.(
          event.isError ? `tool error: ${event.toolName}` : `tool ok: ${event.toolName}`,
        );
        break;

      case "agent_end":
        hooks.onEnd();
        break;

      // Other event types (turn_start/end, message_start/end, etc.) are
      // ignored at this layer; the persisted session.jsonl carries the
      // full record for revival.
    }
  }

  /**
   * Mark the subagent as completed and persist `meta.json`.
   */
  /**
   * Mark the subagent as completed and persist `meta.json`.
   * Persists first; only updates in-memory status on success.
   */
  private markCompleted(instance: SubagentInstance, _finalText: string): void {
    const patch = {
      status: "completed" as const,
      completedAt: new Date().toISOString(),
      // Clear stale error from a previous lifecycle (e.g. after revival).
      errorMessage: undefined,
    };
    this.persistMeta(instance, patch);
    instance.status = "completed";
    this.teardownInstance(instance);
    log.debug("subagent completed", { id: instance.id });
  }

  /**
   * Mark the subagent as errored and persist `meta.json`.
   */
  /**
   * Mark the subagent as errored and persist `meta.json`.
   * Persists first; only updates in-memory status on success.
   */
  private markErrored(instance: SubagentInstance, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
    this.persistMeta(instance, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage,
    });
    instance.status = "error";
    this.teardownInstance(instance);
    log.warn("subagent errored", { id: instance.id, errorMessage });
  }

  /**
   * Read the existing `meta.json`, merge `patch`, and atomically replace.
   * Best-effort: if the read fails, we fall back to a synthetic meta from
   * the in-memory instance state so we never lose the lifecycle write.
   */
  private persistMeta(instance: SubagentInstance, patch: Partial<SubagentMeta>): void {
    let current: SubagentMeta;
    try {
      current = JSON.parse(readFileSync(instance.metaPath, "utf-8")) as SubagentMeta;
    } catch {
      current = {
        id: instance.id,
        role: instance.role,
        name: instance.name,
        spawnedBy: instance.spawnedBy,
        depth: instance.depth,
        createdAt: instance.spawnedAt,
        status: instance.status,
      };
    }
    const merged = { ...current, ...patch };
    // Drop keys set to undefined (e.g. clearing stale errorMessage).
    for (const key of Object.keys(merged) as (keyof SubagentMeta)[]) {
      if (merged[key] === undefined) {
        delete merged[key];
      }
    }
    writeMetaAtomic(instance.metaPath, merged);
  }

  /**
   * Clean up a terminal subagent: null out session and subscription.
   *
   * The instance stays in `activeSubagents` so `list()` can report
   * recently-completed subagents. The heavyweight objects (AgentSession,
   * unsubscribe closure) are released. Prune stale entries lazily on
   * the next `spawn()` call.
   */
  private teardownInstance(instance: SubagentInstance): void {
    instance.unsubscribe?.();
    instance.unsubscribe = null;
    try {
      instance.session?.dispose();
    } catch {
      /* best-effort — session may already be disposed */
    }
    instance.session = null;
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
   */
  private getSharedServices(): SharedServices {
    if (this.services) return this.services;
    const home = this.cfg.goblinHome;
    const authStorage = AuthStorage.create(join(piAgentDir(home), "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(piAgentDir(home), "models.json"),
    );
    const settingsManager = SettingsManager.inMemory({});
    this.services = { authStorage, modelRegistry, settingsManager };
    return this.services;
  }

  /**
   * Resume a persisted subagent and send it a follow-up prompt.
   *
   * Loads the subagent's `meta.json` to locate its session directory, opens
   * the existing `.jsonl` session file via pi's `SessionManager.open()`,
   * reconstructs a `SubagentInstance`, and runs the new prompt through
   * `runAgent()` — reusing all execution wiring (status callbacks, error
   * handling, meta persistence).
   *
   * Throws "Subagent not found" if no `meta.json` exists for the given id.
   */
  async revive(id: string, prompt: string, onStatusUpdate?: (message: string) => void): Promise<string> {
    // Reject if this subagent is already active and running.
    const existing = this.activeSubagents.get(id);
    if (existing !== undefined && existing.status === "running") {
      throw new Error("Subagent is already running");
    }

    // Locate meta.json: could be generic or named. Scan both trees.
    const { dir, meta } = loadSubagentMeta(this.cfg.goblinHome, id);

    // Find the persisted session file inside the subagent's dir.
    const sessionFile = findSessionFile(dir);
    if (sessionFile === null) {
      throw new Error(`Subagent not found`);
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
      definition = loadNamedAgent(this.cfg.goblinHome, meta.name);
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
      depth: meta.depth,
      spawnedAt: meta.createdAt,
      spawnedBy: meta.spawnedBy ?? null,
      dir,
      metaPath: join(dir, "meta.json"),
      sessionManager,
      initialPrompt: prompt,
      onStatusUpdate: prefixStatusCallback(meta.name ?? id.slice(0, 8), onStatusUpdate),
      definition,
      session: null,
      unsubscribe: null,
      result,
    };
    this.activeSubagents.set(id, instance);

    // Update meta to reflect the revival — clear stale terminal fields.
    this.persistMeta(instance, { status: "running", completedAt: undefined, errorMessage: undefined });

    log.debug("subagent revived", { id, role: meta.role, name: meta.name });

    // Kick off execution — same pipeline as spawn().
    this.runAgent(instance, cwd).then(
      (text) => resolveResult(text),
      (err) => rejectResult(err),
    );
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
    if (instance.status !== "running") {
      return;
    }

    try {
      if (instance.session !== null) {
        try {
          await instance.session.abort();
        } catch {
          // abort() may throw if the session is in a bad state.
          // We still want to update status and clean up.
          log.debug("session.abort() threw during cancel", { id, error: "(swallowed)" });
        }
      }
      instance.status = "cancelled";
      this.persistMeta(instance, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
      });
      instance.unsubscribe?.();
      instance.unsubscribe = null;
      this.teardownInstance(instance);
    } catch (err) {
      // persistMeta or teardown failed — still try to clean up.
      instance.status = "cancelled";
      instance.unsubscribe?.();
      instance.unsubscribe = null;
      log.error("cancel cleanup failed", { id, err: err instanceof Error ? err.message : String(err) });
    }

    log.debug("subagent cancelled", { id });
  }

  /**
   * Gracefully shut down all active subagents.
   * Aborts running ones, disposes their sessions, and clears the map.
   */
  async dispose(): Promise<void> {
    const ids = [...this.activeSubagents.keys()];
    for (const id of ids) {
      const instance = this.activeSubagents.get(id);
      if (instance && instance.status === "running") {
        try {
          await instance.session?.abort();
        } catch {
          /* best-effort */
        }
        instance.status = "cancelled";
        this.persistMeta(instance, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
      }
      this.teardownInstance(instance!);
    }
    this.activeSubagents.clear();
    log.debug("SubagentRunner disposed", { count: ids.length });
  }
}

/**
 * Load a named agent definition from `~/goblin/agents/<name>/`.
 *
 * `AGENTS.md` is required. The `skills/` directory is optional — its path
 * is recorded so phase 4 can pin pi's resource loader to it for strict
 * isolation, regardless of whether the agent has any skills yet.
 */
function loadNamedAgent(home: string, name: string): NamedAgentDefinition {
  const agentsMdPath = namedAgentAgentsMdPath(home, name);
  let agentsMd: string;
  try {
    agentsMd = readFileSync(agentsMdPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Named agent '${name}' not found`);
    }
    throw err;
  }
  return {
    name,
    dir: namedAgentDir(home, name),
    agentsMd,
    skillsDir: namedAgentSkillsDir(home, name),
  };
}

/**
 * Locate and parse a subagent's `meta.json` by id.
 *
 * Searches both the generic tree (`~/goblin/subagents/<id>/meta.json`)
 * and all named-agent instance trees (`~/goblin/agents/<name>/instances/<id>/meta.json`).
 *
 * Throws "Subagent not found" if no matching meta.json exists.
 */
function loadSubagentMeta(home: string, id: string): { dir: string; meta: SubagentMeta } {
  const tryParse = (metaPath: string, dir: string): { dir: string; meta: SubagentMeta } | null => {
    try {
      return { dir, meta: JSON.parse(readFileSync(metaPath, "utf-8")) as SubagentMeta };
    } catch {
      // File missing or corrupted — treat as not found.
      return null;
    }
  };

  // Try generic first — most common case.
  const genericResult = tryParse(genericSubagentMetaPath(home, id), genericSubagentDir(home, id));
  if (genericResult !== null) return genericResult;

  // Scan named agents' instances.
  const agentsRoot = namedAgentsRoot(home);
  if (existsSync(agentsRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(agentsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const namedResult = tryParse(
        namedAgentInstanceMetaPath(home, name, id),
        namedAgentInstanceDir(home, name, id),
      );
      if (namedResult !== null) return namedResult;
    }
  }

  throw new Error("Subagent not found");
}

/**
 * Find the most recent `.jsonl` session file inside a directory.
 * Returns `null` if none found.
 *
 * Pi's SessionManager persists sessions as `<timestamp>.jsonl` files
 * (e.g. `2026-04-26T12-00-00.jsonl`). We rely on the timestamp prefix
 * for lexicographic sort to find the most recent. If pi changes the
 * naming convention, this function needs updating.
 */
function findSessionFile(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      // Most recent file first (timestamp prefix sorts lexicographically).
      .reverse();
    return files.length > 0 ? join(dir, files[0] as string) : null;
  } catch {
    return null;
  }
}

/**
 * Wrap a status callback so every message is prefixed with
 * `🧠 <label> `. Named agents use their name; generic agents use
 * the first 8 chars of their UUID. Returns `undefined` when the
 * input callback is `undefined` (no allocation overhead).
 */
function prefixStatusCallback(
  label: string,
  cb: ((msg: string) => void) | undefined,
): ((msg: string) => void) | undefined {
  if (cb === undefined) return undefined;
  const prefix = `🧠 ${label} `;
  return (msg: string) => cb(`${prefix}${msg}`);
}

/**
 * Write JSON to disk via tmp + rename so a crash mid-write doesn't leave
 * a partial meta.json behind.
 */
function writeMetaAtomic(path: string, meta: SubagentMeta): void {
  // tmp file lives in the same directory as the target so the rename is
  // atomic on the same filesystem.
  const tmp = `${dirname(path)}/.meta.${meta.id}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file.
    try { unlinkSync(tmp); } catch { /* already gone or never created */ }
    throw err;
  }
}

// Convenience re-export so callers can pull everything from one entry point.
export type {
  NamedAgentDefinition,
  SpawnOptions,
  SubagentHandle,
  SubagentInfo,
  SubagentInstance,
  SubagentMeta,
  SubagentStatus,
} from "./types.ts";

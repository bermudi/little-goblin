/**
 * Subagent execution engine.
 *
 * Given a fully-constructed `SubagentInstance`, drive it from "running" to
 * a terminal state (`completed` / `error` / `cancelled`):
 *
 *   1. Build the pi `ResourceLoader` (named-agent isolation vs. generic).
 *   2. Create the `AgentSession` with goblin's shared pi services.
 *   3. Subscribe to events, dispatch them through the shared
 *      `dispatchAgentEvent` adapter, accumulate the assistant text.
 *   4. Send the initial prompt; resolve on `agent_end`, reject on errors.
 *   5. Persist the terminal status to `meta.json` and tear down the session.
 *
 * Both `spawn()` and `revive()` on the runner call `runInstance` — the
 * lifecycle entry points only differ in how they construct the instance.
 */

import {
  createAgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { dispatchAgentEvent, type TurnCallbacks } from "../agent/events.ts";
import type { Config } from "../config.ts";
import {
  MemoryStore,
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemorySearchTool,
  createMemoryWriteTool,
  formatSnapshot,
  type MemoryCaller,
} from "../memory/mod.ts";
import { resolveModel } from "../agent/models.ts";
import { log } from "../log.ts";
import { piAgentDir, type PiServices } from "../pi-host.ts";
import type { ActiveScope } from "../memory/mod.ts";
import { persistMetaPatch } from "./meta.ts";
import { buildResourceLoader } from "./named-agents.ts";
import type { SubagentInstance, SubagentStatus } from "./types.ts";

/**
 * Dependencies the execution engine needs but does not own.
 *
 * `buildTools` lets the runner inject `spawn_subagent` / `revive_subagent`
 * without execution.ts having to know about the toolFactory signature.
 */
export interface ExecutionDeps {
  cfg: Config;
  services: PiServices;
  buildTools: (
    depth: number,
    sessionId: string,
    activeScope: ActiveScope,
    onStatusUpdate?: (msg: string) => void,
  ) => ToolDefinition[];
}

/**
 * Wrap a status callback so every message is prefixed with
 * `🧠 <label> `. Named agents use their name; generic agents use
 * the first 8 chars of their UUID. Returns `undefined` when the
 * input callback is `undefined` (no allocation overhead).
 */
export function prefixStatusCallback(
  label: string,
  cb: ((msg: string) => void) | undefined,
): ((msg: string) => void) | undefined {
  if (cb === undefined) return undefined;
  const prefix = `🧠 ${label} `;
  return (msg: string) => cb(`${prefix}${msg}`);
}

/**
 * Drive the instance to a terminal state. Resolves with the accumulated
 * assistant text on `agent_end`, rejects on session errors.
 *
 * Wraps `_runInstanceInner` to catch startup failures (model resolution,
 * createAgentSession, resource loader reload) that would otherwise leave
 * meta.json stuck in "running".
 */
export async function runInstance(
  instance: SubagentInstance,
  cwd: string,
  deps: ExecutionDeps,
): Promise<string> {
  try {
    return await _runInstanceInner(instance, cwd, deps);
  } catch (err) {
    if (instance.status === "running") {
      markErrored(instance, err);
    }
    throw err;
  }
}

async function _runInstanceInner(
  instance: SubagentInstance,
  cwd: string,
  deps: ExecutionDeps,
): Promise<string> {
  const { cfg, services, buildTools } = deps;
  const memoryStore = new MemoryStore(cfg.goblinHome);

  const resolved = resolveModel(cfg);
  services.authStorage.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);

  const resourceLoader = await buildResourceLoader({
    home: cfg.goblinHome,
    cwd,
    role: instance.role,
    definition: instance.definition,
    settingsManager: services.settingsManager,
  });

  // Guard: if cancel() was called before we created the session, stop here.
  const statusBeforeCreate: SubagentStatus = instance.status;
  if (statusBeforeCreate === "cancelled") {
    return "";
  }

  // The caller descriptor is constant across this run: a named subagent
  // sees only its own persona; an anonymous subagent sees none. Compute
  // once and reuse for the memory tools and the per-turn snapshot.
  const caller: MemoryCaller =
    instance.role === "named" && instance.name !== null
      ? { kind: "named-subagent", name: instance.name }
      : { kind: "anonymous-subagent" };

  const { session } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(cfg.goblinHome),
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
    settingsManager: services.settingsManager,
    sessionManager: instance.sessionManager,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
    // Subagents have no β tools — all UI flows through the parent's status
    // callback. See specs/canon/subagents/spec.md "No beta tools for subagents".
    // Pass rawStatusCallback to nested subagent to prevent prefix stacking.
    customTools: [
      ...buildTools(instance.depth, instance.id, instance.activeScope, instance.rawStatusCallback),
      createMemoryReadTool({ store: memoryStore, activeScope: instance.activeScope }),
      createMemoryReadIndexTool({
        store: memoryStore,
        activeScope: instance.activeScope,
        caller,
      }),
      // memory_search mirrors memory_read_index gating but with finer persona
      // control: a named subagent searches its own persona scope; an anonymous
      // subagent searches none. See spec scenario "Named subagent searches
      // own persona only".
      createMemorySearchTool({
        store: memoryStore,
        activeScope: instance.activeScope,
        caller,
      }),
      createMemoryWriteTool({ store: memoryStore, activeScope: instance.activeScope }),
    ],
    ...(resourceLoader ? { resourceLoader } : {}),
  });

  // Guard: if cancel() was called while we were setting up the session,
  // tear down immediately instead of sending the prompt.
  const statusAfterCreate: SubagentStatus = instance.status;
  if (statusAfterCreate === "cancelled") {
    try {
      await session.abort();
    } catch {
      // best-effort
    } finally {
      try {
        session.dispose();
      } catch {
        // best-effort
      }
    }
    return "";
  }

  instance.session = session;

  // Resolve on agent_end, reject on errors during the run.
  let finalText = "";
  let resolveText: ((s: string) => void) | null = null;
  let rejectErr: ((e: unknown) => void) | null = null;
  const completion = new Promise<string>((res, rej) => {
    resolveText = res;
    rejectErr = rej;
  });

  instance.unsubscribe = session.subscribe((event) => {
    try {
      handleEvent(instance, event, {
        onText: (delta) => {
          finalText += delta;
        },
        onEnd: () => {
          markCompleted(instance);
          resolveText?.(finalText);
        },
        onError: (err) => {
          markErrored(instance, err);
          rejectErr?.(err);
        },
      });
    } catch (err) {
      log.error("subagent event handler threw", {
        id: instance.id,
        err: err instanceof Error ? err.message : String(err),
      });
      // Ensure the completion promise settles even if handleEvent or
      // persistMeta throws — otherwise the parent's tool call hangs forever.
      rejectErr?.(err);
    }
  });

  // Fire the initial prompt. If this throws (e.g. provider auth error
  // before any events stream), the outer .then in spawn() turns it into
  // a rejected `handle.result`.
  try {
    const aside = await formatSnapshot({
      store: memoryStore,
      activeScope: instance.activeScope,
      caller,
    });
    if (aside !== null) {
      await session.sendCustomMessage(aside, { deliverAs: "nextTurn" });
    }
    await session.sendUserMessage(instance.initialPrompt);
  } catch (err) {
    markErrored(instance, err);
    throw err;
  }

  return completion;
}

/**
 * Translate a single AgentSession event into status-callback updates
 * and lifecycle hooks. Centralised so the run loop stays linear.
 *
 * Constructs a fresh `TurnCallbacks` adapter per event (no retained state)
 * and delegates to `dispatchAgentEvent` from `src/agent/events.ts` — the
 * same shared dispatch goblin uses.
 */
export function handleEvent(
  instance: SubagentInstance,
  event: AgentSessionEvent,
  hooks: {
    onText: (delta: string) => void;
    onEnd: () => void;
    onError: (err: unknown) => void;
  },
): void {
  const adapter: TurnCallbacks = {
    onTextDelta: (delta) => hooks.onText(delta),
    onToolStart: (name) => instance.onStatusUpdate?.(`tool: ${name}`),
    onToolEnd: (name, isError) => instance.onStatusUpdate?.(
      isError ? `tool error: ${name}` : `tool ok: ${name}`,
    ),
    onStatusUpdate: (msg) => instance.onStatusUpdate?.(msg),
    onMessageStart: () => {},
    onMessageEnd: () => {},
    onAgentEnd: () => hooks.onEnd(),
  };
  dispatchAgentEvent(event, adapter);
}

/**
 * Mark the subagent as completed. Always updates in-memory status and
 * tears down, even if the disk write fails — a logging failure should
 * not destroy a compute result.
 *
 * Guard: does nothing if instance is already in a terminal state
 * (cancelled/error). This prevents race conditions where cancel() sets
 * status to 'cancelled' during await session.abort(), and then agent_end
 * arrives before cancel() resumes.
 */
export function markCompleted(instance: SubagentInstance): void {
  if (instance.status !== "running") {
    log.debug("markCompleted skipped: instance already terminal", {
      id: instance.id,
      status: instance.status,
    });
    return;
  }
  const patch = {
    status: "completed" as const,
    completedAt: new Date().toISOString(),
    // Clear stale error from a previous lifecycle (e.g. after revival).
    errorMessage: undefined,
  };
  try {
    persistMetaPatch(instance, patch);
  } catch (err) {
    log.error("failed to persist completed meta", { id: instance.id, err: err instanceof Error ? err.message : String(err) });
  }
  instance.status = "completed";
  teardownInstance(instance);
  log.debug("subagent completed", { id: instance.id });
}

/**
 * Mark the subagent as errored. Always updates in-memory status and
 * tears down, even if the disk write fails — a logging failure should
 * not prevent cleanup.
 *
 * Guard: does nothing if instance is already in a terminal state
 * (cancelled). This prevents race conditions where cancel() sets
 * status to 'cancelled' during await session.abort(), and then an error
 * event arrives.
 */
export function markErrored(instance: SubagentInstance, err: unknown): void {
  if (instance.status !== "running") {
    log.debug("markErrored skipped: instance already terminal", {
      id: instance.id,
      status: instance.status,
    });
    return;
  }
  const errorMessage = err instanceof Error ? err.message : String(err);
  try {
    persistMetaPatch(instance, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage,
    });
  } catch (persistErr) {
    log.error("failed to persist error meta", { id: instance.id, err: persistErr instanceof Error ? persistErr.message : String(persistErr) });
  }
  instance.status = "error";
  teardownInstance(instance);
  log.warn("subagent errored", { id: instance.id, errorMessage });
}

/**
 * Clean up a terminal subagent: null out session and subscription.
 *
 * The instance stays in the runner's `activeSubagents` map so `list()`
 * can report recently-completed subagents. The heavyweight objects
 * (AgentSession, unsubscribe closure) are released. Prune stale entries
 * lazily on the next `spawn()` call.
 */
export function teardownInstance(instance: SubagentInstance): void {
  instance.unsubscribe?.();
  instance.unsubscribe = null;
  try {
    instance.session?.dispose();
  } catch {
    /* best-effort — session may already be disposed */
  }
  instance.session = null;
}

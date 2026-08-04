/**
 * Subagent lifecycle execution coordinator.
 *
 * This module owns invocation preparation, memory/tool assembly, and durable
 * terminal transitions. Pi construction and Pi event mechanics live behind
 * `SubagentHost`; no Pi session object escapes this boundary.
 */

import {
  MemoryStore,
  createMemorySearchTool,
  createMemoryWriteTool,
  captureInvocationMemoryContext,
  formatRelevantMemory,
  type CapturedMemoryContext,
} from "../memory/mod.ts";
import { boundedError, log } from "../log.ts";
import type { SubagentInvocation } from "./host.ts";
import type { AttachedDelegatedWorkOwnership, DelegatedRuntimeContext } from "../delegated-work/mod.ts";
import { persistMetaPatch } from "./meta.ts";
import type { GenericSubagentInheritance, SubagentInstance } from "./types.ts";

/**
 * Terminal execution failed and its durable error transition failed as well.
 * The original execution error is retained as `cause` and as
 * `executionError`; the persistence failure is carried separately so callers
 * can diagnose both without pretending either one succeeded.
 */
export class SubagentTerminalError extends Error {
  readonly executionError: unknown;
  readonly persistenceError: unknown;

  constructor(executionError: unknown, persistenceError: unknown) {
    super(
      `Subagent execution failed: ${boundedError(executionError).error}; ` +
        `metadata persistence failed: ${boundedError(persistenceError).error}`,
      { cause: executionError },
    );
    this.name = "SubagentTerminalError";
    this.executionError = executionError;
    this.persistenceError = persistenceError;
  }
}

/** Dependencies owned by the coordinator, not by the Pi host. */
export interface ExecutionDeps {
  memoryStore: MemoryStore;
  buildTools: (
    depth: number,
    sessionId: string,
    parentCapture: CapturedMemoryContext,
    inheritance: GenericSubagentInheritance | null,
    onStatusUpdate?: (msg: string) => void,
    delegatedContext?: DelegatedRuntimeContext | AttachedDelegatedWorkOwnership,
    parentSubagentId?: string,
  ) => SubagentInvocation["customTools"];
}

/**
 * Wrap a status callback so every message is prefixed with
 * `🧠 <label> `. Named agents use their name; generic agents use
 * the first 8 chars of their UUID.
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
 * Drive the instance to a terminal state. Memory and Pi resources have
 * separate owners: this coordinator closes the former, while the host lease
 * closes the latter before its `run()` promise settles.
 */
export async function runInstance(
  instance: SubagentInstance,
  deps: ExecutionDeps,
): Promise<string> {
  let text: string | undefined;
  let executionFailure: unknown;
  try {
    text = await runInvocation(instance, deps);
  } catch (err) {
    executionFailure = err;
  }

  // Memory search records recall statistics on the next event-loop turn. Let
  // that deferred store work drain before closing this invocation-owned store;
  // otherwise a successful search races its own teardown and emits a noisy
  // "closed database" warning.
  await new Promise<void>((resolve) => setImmediate(resolve));

  let closeFailure: unknown;
  try {
    deps.memoryStore.close();
  } catch (err) {
    closeFailure = err;
    log.error("subagent memory store close failed", {
      id: instance.id,
      ...boundedError(err),
    });
  }

  const failure = combineFailures(
    [executionFailure, closeFailure].filter((value) => value !== undefined),
    "Subagent execution and cleanup failed",
  );
  if (failure !== null) {
    if (instance.status === "running") {
      try {
        markErrored(instance, failure);
      } catch (persistenceFailure) {
        if (persistenceFailure instanceof SubagentTerminalError && closeFailure === undefined) {
          throw persistenceFailure;
        }
        throw combineFailures([failure, persistenceFailure], "Subagent terminal transition failed") ?? persistenceFailure;
      }
    }
    throw failure;
  }

  if (instance.status === "running") {
    // A compliant host reserves completion synchronously at agent_settled.
    // Keep the fallback for small injected hosts that simply resolve run().
    // A runtime fence must never be converted into a successful delivery.
    if (instance.runtimeFenced && !instance.completionClaimed) {
      throw new Error(`Subagent '${instance.id}' was fenced before completion was claimed`);
    }
    instance.completionClaimed = true;
    markCompleted(instance);
  }
  return text ?? "";
}

function combineFailures(failures: readonly unknown[], message: string): Error | null {
  if (failures.length === 0) return null;
  if (failures.length === 1) {
    const failure = failures[0];
    return failure instanceof Error ? failure : new Error(String(failure));
  }
  return new AggregateError(failures, message);
}

async function runInvocation(
  instance: SubagentInstance,
  deps: ExecutionDeps,
): Promise<string> {
  const preparedExecution = instance.execution;
  let runStarted = false;
  let primaryFailure: unknown;
  try {
    if (isCancelled(instance)) return "";

    // Capture a fresh invocation-lifetime memory context from the inherited
    // Surface authority and child caller descriptor. This remains coordinator
    // work; the host receives only the resulting prompt material and tools.
    const capture = await captureInvocationMemoryContext({
      authority: instance.authority,
      caller: instance.caller,
      store: deps.memoryStore,
    });
    instance.capture = capture;
    if (isCancelled(instance)) return "";

    const relevantMemoryPrelude = await formatRelevantMemory({
      store: deps.memoryStore,
      context: capture,
      promptText: instance.initialPrompt,
    });
    if (isCancelled(instance)) return "";

    const customTools = [
      ...deps.buildTools(
        instance.depth,
        instance.id,
        capture,
        instance.inheritance,
        rawStatusCallbackFor(instance),
        instance.delegatedOwnership ?? undefined,
        instance.id,
      ),
      // memory_search subsumes the old memory_read and memory_read_index tools.
      // Persona gating is encoded by the captured caller/context.
      createMemorySearchTool({
        store: deps.memoryStore,
        context: capture,
      }),
      createMemoryWriteTool({ store: deps.memoryStore, context: capture }),
    ];
    if (isCancelled(instance)) return "";

    const execution = instance.execution;
    if (execution === null) {
      throw new Error(`Subagent '${instance.id}' has no prepared execution lease`);
    }

    // The status check and lease assignment are synchronous. A cancellation
    // that wins before this point never creates Pi resources; a cancellation
    // after it is handled by the host's stop fence.
    if (isCancelled(instance)) return "";

    runStarted = true;
    try {
      return await execution.run({
        prompt: instance.initialPrompt,
        systemPrompt: systemPromptFor(instance, capture),
        relevantMemoryPrelude: relevantMemoryPrelude ?? undefined,
        customTools,
        onStatusUpdate: statusCallbackFor(instance),
        onCompletionClaimed: () => {
          if (instance.status === "running" && !instance.runtimeFenced) {
            instance.completionClaimed = true;
          }
        },
      });
    } catch (error) {
      primaryFailure = error;
      throw error;
    }
  } catch (error) {
    primaryFailure ??= error;
    throw error;
  } finally {
    if (preparedExecution !== null && instance.execution === preparedExecution) {
      if (!runStarted) {
        try {
          await preparedExecution.stop();
        } catch (stopFailure) {
          throw combineFailures(
            [primaryFailure, stopFailure].filter((value) => value !== undefined),
            "Subagent execution cleanup failed",
          ) ?? stopFailure;
        }
      }
      instance.execution = null;
    }
  }
}

function isCancelled(instance: SubagentInstance): boolean {
  return instance.status === "cancelled" || instance.runtimeFenced;
}

function statusCallbackFor(instance: SubagentInstance): ((message: string) => void) | undefined {
  if (instance.onStatusUpdate === undefined) return undefined;
  return (message: string) => {
    if (!instance.runtimeFenced && instance.status === "running") {
      instance.onStatusUpdate?.(message);
    }
  };
}

function rawStatusCallbackFor(instance: SubagentInstance): ((message: string) => void) | undefined {
  if (instance.rawStatusCallback === undefined) return undefined;
  return (message: string) => {
    if (!instance.runtimeFenced && instance.status === "running") {
      instance.rawStatusCallback?.(message);
    }
  };
}

function systemPromptFor(
  instance: SubagentInstance,
  capture: CapturedMemoryContext,
): string | undefined {
  const sections: string[] = [];
  if (instance.definition !== null) sections.push(instance.definition.agentsMd);
  if (capture.frozenSummary) sections.push(capture.frozenSummary);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/**
 * Mark the subagent as completed. Always updates in-memory status and
 * tears down. If the durable transition fails, the persistence error is
 * raised after cleanup so callers cannot report a successful run with stale
 * metadata.
 */
export function markCompleted(instance: SubagentInstance): void {
  if (instance.status !== "running") {
    log.debug("markCompleted skipped: instance already terminal", {
      id: instance.id,
      status: instance.status,
    });
    return;
  }
  instance.completionClaimed = true;
  const deliveryState = instance.delegatedOwnership === null
    ? "delivered" as const
    : "pending" as const;
  const patch = {
    status: "completed" as const,
    completedAt: new Date().toISOString(),
    errorMessage: undefined,
    deliveryState,
  };
  let persistenceFailed = false;
  let persistenceError: unknown;
  try {
    persistMetaPatch(instance, patch);
  } catch (err) {
    persistenceFailed = true;
    persistenceError = err;
    log.error("failed to persist completed meta", { id: instance.id, ...boundedError(err) });
  }
  instance.status = "completed";
  instance.deliveryState = persistenceFailed ? "suppressed" : deliveryState;
  // Attached work keeps its host registration while its blocking caller still
  // owns an undelivered result. `acknowledgeDelivery()` releases it after the
  // tool has accepted the result; runtime invalidation can therefore suppress
  // a completed-but-not-yet-delivered result without resurrecting it.
  // A failed terminal write cannot safely remain pending: the result is
  // rejected below and the registration must not become an untracked leak.
  if (persistenceFailed) teardownInstance(instance);
  log.debug("subagent completed", { id: instance.id });
  if (persistenceFailed) throw persistenceError;
}

/**
 * Mark the subagent as errored. The execution error remains the primary
 * failure; a durable-transition failure is combined in SubagentTerminalError.
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
  let persistenceFailed = false;
  let persistenceError: unknown;
  try {
    persistMetaPatch(instance, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage,
      deliveryState: "suppressed",
    });
  } catch (persistErr) {
    persistenceFailed = true;
    persistenceError = persistErr;
    log.error("failed to persist error meta", { id: instance.id, ...boundedError(persistErr) });
  }
  instance.status = "error";
  instance.deliveryState = "suppressed";
  instance.completionClaimed = false;
  teardownInstance(instance);
  log.warn("subagent errored", { id: instance.id, ...boundedError(errorMessage) });
  if (persistenceFailed) throw new SubagentTerminalError(err, persistenceError);
}

/**
 * Drop the opaque invocation lease from the lifecycle record. Normal run
 * completion and explicit cancellation have already asked the host to stop;
 * this function only severs coordinator references and never reimplements Pi
 * cleanup policy.
 */
export function teardownInstance(
  instance: SubagentInstance,
  releaseDelegatedRegistration = true,
): void {
  instance.execution = null;
  if (releaseDelegatedRegistration && instance.deliveryState !== "pending") {
    instance.delegatedRegistration?.release();
    instance.delegatedRegistration = null;
  }
}

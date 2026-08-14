import type { AgentRunner } from "../agent/mod.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import type { SurfaceId } from "../surface.ts";
export type {
  AttachmentSignal,
  AttachedWork,
  CurrentBindingGuard,
  SurfaceRuntimeAuthority,
} from "./surface-runtime-authority.ts";
import { DelegatedWorkHost, type ConversationRuntimeId } from "../delegated-work/mod.ts";
import { log } from "../log.ts";

/**
 * Preserve lifecycle-command serialization while invalidating model work.
 * Commands use Binding authority rather than a disposed runner's identity.
 */
export interface RuntimeDisposalOptions {
  readonly preserveCommandQueue?: boolean;
  /** Keep this candidate reservation alive while replacing an old runtime. */
  readonly preserveInFlight?: Promise<AgentRunner>;
}

/** Narrow lifecycle-facing port used by ConversationLifecycle. */
export interface ConversationRuntimeHostPort {
  hasRuntime(conversationId: ConversationId): boolean;
  disposeRuntime(conversationId: ConversationId, options?: RuntimeDisposalOptions): Promise<void>;
}

/** Frozen settings and skill identity captured by one runtime generation. */
export interface RuntimeSkillContext {
  readonly settingsFingerprint: string;
  readonly policyFingerprint: string;
  readonly manifestFingerprint: string | null;
}

export interface SurfaceRuntimeRegistration {
  readonly surfaceId: SurfaceId;
  readonly runtimeId: ConversationRuntimeId;
  readonly skillContext: RuntimeSkillContext;
}

/** One in-flight runtime construction reservation. */
export interface RuntimeCreation {
  readonly conversationId: ConversationId;
  readonly promise: Promise<AgentRunner>;
  readonly completion: Promise<void>;
  readonly surfaceId: SurfaceId;
  /** Fingerprint of the complete Surface runtime-settings snapshot. */
  readonly settingsFingerprint: string;
  resolve(runner: AgentRunner): void;
  reject(error: unknown): void;
  complete(): void;
}

interface PromptQueueEntry {
  readonly isPrompt: boolean;
}

/** One in-flight disposal tagged with the generation it is tearing down. */
interface ActiveDisposal {
  readonly generation: number;
  readonly promise: Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

class DelegatedInvalidationFailure extends Error {
  readonly runtimeId: ConversationRuntimeId;

  constructor(runtimeId: ConversationRuntimeId, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DelegatedInvalidationFailure";
    this.runtimeId = runtimeId;
    this.cause = cause;
  }
}

function isPendingDelegatedInvalidation(
  pending: ReadonlyMap<ConversationId, Set<ConversationRuntimeId>>,
  runtimeId: ConversationRuntimeId,
): boolean {
  for (const runtimeIds of pending.values()) {
    if (runtimeIds.has(runtimeId)) return true;
  }
  return false;
}

function deferred<T>(swallowRejection = false): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (swallowRejection) promise.catch(() => {});
  return { promise, resolve, reject };
}

function flattenFailures(error: unknown, failures: unknown[]): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) flattenFailures(nested, failures);
    return;
  }
  failures.push(error);
}

/**
 * Concrete owner of ephemeral ConversationRuntime state.
 *
 * It owns runner registration, runtime generations, in-flight construction,
 * prompt queues, and cleanup. It does not construct runners or resolve Binding
 * authority; those policies belong to TurnDispatcher and ConversationLifecycle.
 */
export class ConversationRuntimeHost implements ConversationRuntimeHostPort {
  private readonly runners: Map<ConversationId, AgentRunner>;
  private readonly runnerSurfaceIds = new Map<ConversationId, SurfaceId>();
  private readonly runnerRuntimeIds = new Map<ConversationId, ConversationRuntimeId>();
  /** Runtime IDs whose delegated-work fence has not yet succeeded. They remain
   * retryable after the runner registration itself has been synchronously
   * invalidated. */
  private readonly pendingDelegatedInvalidations = new Map<ConversationId, Set<ConversationRuntimeId>>();
  private readonly runnerSkillContexts = new Map<ConversationId, RuntimeSkillContext>();
  private readonly internalRunnerIds = new Set<ConversationId>();
  private readonly inFlightCreations = new Map<ConversationId, RuntimeCreation>();
  private readonly creationReservations = new Set<RuntimeCreation>();
  private readonly promptQueues = new Map<ConversationId, Promise<void>>();
  private readonly promptQueueMeta = new Map<ConversationId, PromptQueueEntry>();
  /** Every cleanup still draining, grouped by Conversation. Multiple
   * generations may overlap when a replacement is invalidated before an older
   * generation has physically settled. */
  private readonly activeDisposals = new Map<ConversationId, Set<ActiveDisposal>>();
  private readonly queuedWork = new Set<Promise<void>>();
  /**
   * Monotonic per-Conversation generation counter. Bumped on every runtime
   * registration or creation reservation so disposal deduplication can tell a
   * same-generation retry from a new generation that registered while a prior
   * generation's cleanup was still draining.
   */
  private readonly generations = new Map<ConversationId, number>();
  private admissionOpen = true;
  private shutdownPromise: Promise<void> | undefined;
  /**
   * The single DelegatedWorkHost for this kernel, exposed so every orchestration
   * component derives delegated-work access from one owner instead of carrying
   * its own possibly-divergent instance (decision: shared delegated host).
   */
  readonly delegatedWorkHost: DelegatedWorkHost;
  private readonly externalAgentRunner: ExternalAgentRunner | undefined;

  constructor(options: {
    delegatedWorkHost: DelegatedWorkHost;
    externalAgentRunner?: ExternalAgentRunner;
  }) {
    this.runners = new Map<ConversationId, AgentRunner>();
    this.delegatedWorkHost = options.delegatedWorkHost;
    this.externalAgentRunner = options.externalAgentRunner;
  }

  /** Advance and return the next generation token for a Conversation. */
  private nextGeneration(conversationId: ConversationId): number {
    const next = (this.generations.get(conversationId) ?? 0) + 1;
    this.generations.set(conversationId, next);
    return next;
  }

  getRunner(conversationId: ConversationId): AgentRunner | null {
    return this.runners.get(conversationId) ?? null;
  }

  hasRunner(conversationId: ConversationId): boolean {
    return this.runners.has(conversationId);
  }

  hasRuntime(conversationId: ConversationId): boolean {
    return this.runners.has(conversationId) || this.inFlightCreations.has(conversationId);
  }

  isAdmissionOpen(): boolean {
    return this.admissionOpen;
  }

  /** Stop new runtime creation and not-yet-started queued work. Idempotent and synchronous. */
  closeAdmission(): void {
    if (this.admissionOpen) {
      this.admissionOpen = false;
      log.info("conversation runtime admission closed");
    }
  }

  assertAdmissionOpen(): void {
    if (!this.admissionOpen) {
      throw new Error("conversation runtime admission is closed");
    }
  }

  isRegisteredRunner(conversationId: ConversationId, runner: AgentRunner): boolean {
    return this.runners.get(conversationId) === runner;
  }

  isInternalRuntime(conversationId: ConversationId): boolean {
    return this.internalRunnerIds.has(conversationId);
  }

  surfaceIdFor(conversationId: ConversationId): SurfaceId | undefined {
    return this.runnerSurfaceIds.get(conversationId);
  }

  runtimeIdFor(conversationId: ConversationId): ConversationRuntimeId | undefined {
    return this.runnerRuntimeIds.get(conversationId);
  }

  skillContextFor(conversationId: ConversationId): RuntimeSkillContext | undefined {
    return this.runnerSkillContexts.get(conversationId);
  }

  creationFor(conversationId: ConversationId): RuntimeCreation | undefined {
    return this.inFlightCreations.get(conversationId);
  }

  reserveCreation(
    conversationId: ConversationId,
    surfaceId: SurfaceId,
    settingsFingerprint: string,
  ): RuntimeCreation {
    this.assertAdmissionOpen();
    // A new candidate generation must be distinguishable from the generation
    // currently being disposed, otherwise a later disposal would dedup against
    // the stale promise and let this replacement escape fencing.
    this.nextGeneration(conversationId);
    const control = deferred<AgentRunner>(true);
    const completion = deferred<void>();
    let creation!: RuntimeCreation;
    const complete = (): void => {
      completion.resolve(undefined);
      this.creationReservations.delete(creation);
      if (this.inFlightCreations.get(conversationId) === creation) {
        this.inFlightCreations.delete(conversationId);
      }
    };
    creation = {
      conversationId,
      promise: control.promise,
      completion: completion.promise,
      surfaceId,
      settingsFingerprint,
      resolve: control.resolve,
      reject: control.reject,
      complete,
    };
    this.inFlightCreations.set(conversationId, creation);
    this.creationReservations.add(creation);
    return creation;
  }

  isCurrentCreation(conversationId: ConversationId, promise: Promise<AgentRunner>): boolean {
    return this.inFlightCreations.get(conversationId)?.promise === promise;
  }

  finishCreation(
    conversationId: ConversationId,
    promise: Promise<AgentRunner>,
    creation: RuntimeCreation,
  ): void {
    creation.complete();
    if (this.inFlightCreations.get(conversationId)?.promise === promise) {
      this.inFlightCreations.delete(conversationId);
    }
  }

  registerSurfaceRuntime(
    conversationId: ConversationId,
    runner: AgentRunner,
    registration: SurfaceRuntimeRegistration,
  ): void {
    this.assertAdmissionOpen();
    if ((this.activeDisposals.get(conversationId)?.size ?? 0) > 0) {
      throw new Error(
        `cannot register runtime for ${conversationId}: a prior-generation disposal is still active`,
      );
    }
    if (this.runners.has(conversationId)) {
      throw new Error(`Conversation runtime already registered for ${conversationId}`);
    }
    if (this.internalRunnerIds.has(conversationId)) {
      throw new Error(`Conversation ${conversationId} is reserved by an internal runtime`);
    }
    // Commit a new generation only after the caller has drained any prior
    // cleanup via awaitSettled; the assert above keeps the invariant loud.
    this.nextGeneration(conversationId);
    this.runners.set(conversationId, runner);
    this.runnerSurfaceIds.set(conversationId, registration.surfaceId);
    this.runnerRuntimeIds.set(conversationId, registration.runtimeId);
    this.runnerSkillContexts.set(conversationId, registration.skillContext);
  }

  registerInternalRuntime(conversationId: ConversationId, runner: AgentRunner): void {
    this.assertAdmissionOpen();
    if ((this.activeDisposals.get(conversationId)?.size ?? 0) > 0) {
      throw new Error(
        `cannot register internal runtime for ${conversationId}: a prior-generation disposal is still active`,
      );
    }
    if (this.runners.has(conversationId) && !this.internalRunnerIds.has(conversationId)) {
      throw new Error(`cannot reuse Surface-backed runtime ${conversationId} for an internal turn`);
    }
    this.nextGeneration(conversationId);
    this.runners.set(conversationId, runner);
    this.internalRunnerIds.add(conversationId);
  }

  /**
   * Resolve once every in-progress disposal for this Conversation has settled.
   * A replacement generation awaits this before committing so a runner never
   * registers while a prior generation's runner/delegated cleanup is draining.
   */
  async awaitSettled(conversationId: ConversationId): Promise<void> {
    // Loop: a disposal that completes may reveal another that started against
    // the same Conversation. Each iteration awaits one active disposal; the
    // caller's own creation checkpoints handle any invalidation that arrived
    // while it was suspended.
    for (;;) {
      const active = this.activeDisposals.get(conversationId);
      if (active === undefined || active.size === 0) return;
      await Promise.all([...active].map((entry) => entry.promise));
    }
  }

  schedule(
    conversationId: ConversationId,
    isCurrent: () => boolean,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    options: { isPrompt?: boolean } = {},
  ): boolean {
    if (!this.admissionOpen) {
      log.info("runtime work rejected after admission closed", { conversationId });
      return false;
    }
    let started = false;
    const execute = async (): Promise<void> => {
      // A queue entry is admitted when schedule() succeeds, but shutdown must
      // still fence entries that have not reached the front of the chain. An
      // entry that has started is allowed to drain; this distinction is what
      // keeps shutdown from starting a command after its runtime was fenced.
      if (!started && !this.admissionOpen) return;
      started = true;
      if (!isCurrent()) return;
      try {
        await run(isCurrent);
      } catch (err) {
        if (!isCurrent()) return;
        try {
          await onError(err);
        } catch (handlerErr) {
          log.error("runtime queue error handler failed", {
            conversationId,
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        }
      }
    };
    const prior = this.promptQueues.get(conversationId);
    let current: Promise<void>;
    let startImmediately: (() => void) | undefined;
    if (prior) {
      current = prior.then(execute, execute);
    } else {
      // Reserve the queue promise before starting the first entry. This keeps
      // admission visible to re-entrant code without changing the historical
      // synchronous start of an idle queue.
      const control = deferred<void>(true);
      current = control.promise;
      startImmediately = (): void => {
        void execute().then(control.resolve, control.reject);
      };
    }
    const meta: PromptQueueEntry = { isPrompt: options.isPrompt ?? true };
    this.promptQueues.set(conversationId, current);
    this.promptQueueMeta.set(conversationId, meta);
    this.queuedWork.add(current);
    startImmediately?.();
    const remove = (): void => {
      this.queuedWork.delete(current);
      if (this.promptQueues.get(conversationId) === current) this.promptQueues.delete(conversationId);
      if (this.promptQueueMeta.get(conversationId) === meta) this.promptQueueMeta.delete(conversationId);
    };
    // Handle both outcomes so a caller that does not await a fire-and-forget
    // queue cannot create an unhandled rejection while shutdown is draining it.
    void current.then(remove, remove);
    return true;
  }

  isCommandPending(conversationId: ConversationId): boolean {
    const meta = this.promptQueueMeta.get(conversationId);
    return meta !== undefined && !meta.isPrompt;
  }

  isPromptPending(conversationId: ConversationId): boolean {
    const meta = this.promptQueueMeta.get(conversationId);
    return meta !== undefined && meta.isPrompt;
  }

  async cancelPending(conversationId: ConversationId): Promise<boolean> {
    const meta = this.promptQueueMeta.get(conversationId);
    if (!meta || !meta.isPrompt) return false;
    const runner = this.getRunner(conversationId);
    if (runner && !runner.isStreaming) await runner.abort();
    return true;
  }

  /**
   * Invalidate synchronously, then await runner and external-work cleanup.
   *
   * Deduplication is generation-aware: a second call for the SAME generation
   * shares the in-flight disposal promise, but a call made after a newer
   * generation registered (or reserved a creation) starts a fresh disposal so
   * the replacement cannot hide behind the prior generation's promise.
   */
  disposeRuntime(
    conversationId: ConversationId,
    disposalOptions?: RuntimeDisposalOptions,
  ): Promise<void> {
    const currentGeneration = this.generations.get(conversationId) ?? 0;

    // Every caller applies its requested authority fence, even when physical
    // cleanup for this generation is already in flight. A later stronger call
    // can therefore revoke a creation or command queue that an earlier call
    // deliberately preserved.
    const cleanup = this.fenceRuntime(conversationId, disposalOptions);

    const active = this.activeDisposals.get(conversationId);
    const existing = active === undefined
      ? undefined
      : [...active].find((entry) => entry.generation === currentGeneration);
    if (existing !== undefined) return existing.promise;

    const disposal = this.disposeRuntimeOnce(conversationId, cleanup);
    const entry: ActiveDisposal = { generation: currentGeneration, promise: disposal };
    const entries = active ?? new Set<ActiveDisposal>();
    entries.add(entry);
    this.activeDisposals.set(conversationId, entries);
    const clearActiveDisposal = (): void => {
      entries.delete(entry);
      if (entries.size === 0 && this.activeDisposals.get(conversationId) === entries) {
        this.activeDisposals.delete(conversationId);
      }
    };
    // Keep the returned promise's identity stable for concurrent callers and
    // handle both outcomes on the cleanup observer so a rejected disposal is
    // reported to its caller without creating a second unhandled rejection.
    void disposal.then(clearActiveDisposal, clearActiveDisposal);
    return disposal;
  }

  private fenceRuntime(
    conversationId: ConversationId,
    disposalOptions?: RuntimeDisposalOptions,
  ): { runner: AgentRunner | undefined; runtimeIds: ConversationRuntimeId[] } {
    const prior = this.runners.get(conversationId);
    const runtimeId = this.runnerRuntimeIds.get(conversationId);
    if (runtimeId !== undefined) {
      const pending = this.pendingDelegatedInvalidations.get(conversationId) ?? new Set();
      pending.add(runtimeId);
      this.pendingDelegatedInvalidations.set(conversationId, pending);
    }

    // This is the authority fence. No queued work or late runner event can
    // observe the old registration after this synchronous section.
    this.runners.delete(conversationId);
    this.runnerSurfaceIds.delete(conversationId);
    this.runnerRuntimeIds.delete(conversationId);
    this.runnerSkillContexts.delete(conversationId);
    this.internalRunnerIds.delete(conversationId);

    const currentCreation = this.inFlightCreations.get(conversationId);
    const preserveInFlight = disposalOptions?.preserveInFlight;
    if (!preserveInFlight || currentCreation?.promise !== preserveInFlight) {
      this.inFlightCreations.delete(conversationId);
    }

    const pendingQueueMeta = this.promptQueueMeta.get(conversationId);
    const preserveCommandQueue = disposalOptions?.preserveCommandQueue === true && pendingQueueMeta?.isPrompt === false;
    if (!preserveCommandQueue) {
      this.promptQueues.delete(conversationId);
      this.promptQueueMeta.delete(conversationId);
    }

    return {
      runner: prior,
      runtimeIds: [...(this.pendingDelegatedInvalidations.get(conversationId) ?? [])],
    };
  }

  private async disposeRuntimeOnce(
    conversationId: ConversationId,
    cleanup: { runner: AgentRunner | undefined; runtimeIds: ConversationRuntimeId[] },
  ): Promise<void> {
    const prior = cleanup.runner;
    const delegatedFailures: unknown[] = [];
    // Start delegated fencing immediately, but do not await it before invoking
    // runner.dispose(): both cleanup boundaries should make progress together.
    const delegatedInvalidation = Promise.all(cleanup.runtimeIds.map(async (runtimeId) => {
      try {
        await this.delegatedWorkHost.invalidateRuntime(runtimeId);
        const pending = this.pendingDelegatedInvalidations.get(conversationId);
        pending?.delete(runtimeId);
        if (pending?.size === 0) this.pendingDelegatedInvalidations.delete(conversationId);
      } catch (error) {
        delegatedFailures.push(new DelegatedInvalidationFailure(runtimeId, error));
        log.error("delegated work invalidation failed in runtime disposal", {
          conversationId,
          runtimeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));

    let runnerError: unknown;
    let runnerFailed = false;
    if (prior) {
      try {
        await prior.dispose();
      } catch (error) {
        runnerFailed = true;
        runnerError = error;
        log.error("AgentRunner.dispose failed in runtime disposal", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await delegatedInvalidation;

    let externalTimer: ReturnType<typeof setTimeout> | undefined;
    const externalCancellation = this.externalAgentRunner
      ? this.externalAgentRunner.cancelBySession(conversationId)
      : Promise.resolve();
    let externalCancellationTimedOut = false;
    let externalCancellationError: unknown;
    let externalCancellationFailed = false;
    const timeout = new Promise<void>((resolve) => {
      externalTimer = setTimeout(() => {
        externalCancellationTimedOut = true;
        log.warn("external-agent cancellation timed out in runtime disposal", { conversationId });
        resolve();
      }, 10_000);
    });
    try {
      await Promise.race([externalCancellation, timeout]);
    } catch (error) {
      externalCancellationFailed = true;
      externalCancellationError = error;
      log.error("external-agent cancellation failed in runtime disposal", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (externalTimer !== undefined) clearTimeout(externalTimer);
    }

    const failures: unknown[] = [];
    if (runnerFailed) failures.push(runnerError);
    failures.push(...delegatedFailures);
    if (externalCancellationTimedOut) {
      failures.push(new Error(`external-agent cancellation timed out for ${conversationId}`));
    }
    if (externalCancellationFailed) failures.push(externalCancellationError);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Conversation runtime cleanup failed");
  }

  disposeAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closeAdmission();

    // Fence every runtime immediately. Shutdown must be able to abort a model
    // turn that would otherwise keep its admitted Telegram handler alive
    // indefinitely. Queue promises are still drained below, but entries that
    // have not started fail the admission fence instead of starting new work
    // during shutdown.
    const ids = new Set([
      ...this.runners.keys(),
      ...this.inFlightCreations.keys(),
      ...this.pendingDelegatedInvalidations.keys(),
    ]);
    const eagerDisposals = [...ids].map((conversationId) => this.disposeRuntime(conversationId));

    this.shutdownPromise = this.disposeAllOnce(eagerDisposals);
    return this.shutdownPromise;
  }

  private async disposeAllOnce(eagerDisposals: readonly Promise<void>[]): Promise<void> {
    const failures: unknown[] = [];
    const observedQueuedWork = new Set<Promise<void>>();
    // Drain accepted queue chains after their runtime generations have been
    // fenced. A currently executing turn is unblocked by runner disposal;
    // queued entries observe the admission fence and do not begin during
    // shutdown.
    for (;;) {
      const queued = [...this.queuedWork];
      const accepted = await Promise.allSettled(queued);
      for (const [index, result] of accepted.entries()) {
        const promise = queued[index];
        if (promise === undefined) continue;
        if (result.status === "rejected" && !observedQueuedWork.has(promise)) {
          observedQueuedWork.add(promise);
          flattenFailures(result.reason, failures);
        }
      }
      if (this.queuedWork.size === 0) break;
    }

    // Eager cleanup started before the queue drain so idle runtimes were fenced
    // synchronously. Retain those exact promises until now: activeDisposals is
    // only a live-work index, so a fast rejection may have left that map while
    // an unrelated queue was still draining.
    const eagerResults = await Promise.allSettled(eagerDisposals);
    for (const result of eagerResults) {
      if (result.status === "rejected") flattenFailures(result.reason, failures);
    }

    // Constructions and physical cleanup can now be fenced and drained. Retry
    // each delegated invalidation left by an earlier failed disposal once in
    // this shutdown attempt; persistent failure is reported rather than spun.
    const attemptedPendingInvalidations = new Set<ConversationId>();
    for (;;) {
      const creations = [...this.creationReservations];
      const retryablePending = [...this.pendingDelegatedInvalidations.keys()].filter(
        (conversationId) => !attemptedPendingInvalidations.has(conversationId),
      );
      retryablePending.forEach((conversationId) => attemptedPendingInvalidations.add(conversationId));
      const ids = new Set([
        ...this.runners.keys(),
        ...this.inFlightCreations.keys(),
        ...this.activeDisposals.keys(),
        ...retryablePending,
        ...creations.map((creation) => creation.conversationId),
      ]);
      const disposals = [...ids].map((conversationId) => this.disposeRuntime(conversationId));
      const results = await Promise.allSettled([
        ...disposals,
        ...creations.map((creation) => creation.completion),
      ]);
      for (const result of results) {
        if (result.status === "rejected") flattenFailures(result.reason, failures);
      }

      // Cleanup observers remove settled active disposals and queue entries in
      // promise reactions. Yield once before checking the owner state so the
      // shutdown promise cannot resolve while one of those entries is still
      // visible as active.
      await Promise.resolve();
      if (
        this.runners.size === 0 &&
        this.inFlightCreations.size === 0 &&
        this.creationReservations.size === 0 &&
        this.activeDisposals.size === 0 &&
        this.queuedWork.size === 0
      ) {
        break;
      }
    }

    // A delegated invalidation may fail transiently, remain pending, and then
    // succeed on the bounded retry above. Do not report an error that has been
    // demonstrably recovered; runner and other cleanup failures remain loud.
    const reportableFailures = failures.filter((failure) =>
      !(failure instanceof DelegatedInvalidationFailure) ||
      isPendingDelegatedInvalidation(this.pendingDelegatedInvalidations, failure.runtimeId)
    );
    if (reportableFailures.length === 1) {
      const failure = reportableFailures[0];
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    if (reportableFailures.length > 1) {
      throw new AggregateError(reportableFailures, "Conversation runtime shutdown failed");
    }
  }
}

import type { AgentRunner } from "../agent/mod.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import type { SurfaceId } from "../surface.ts";
import type {
  ConversationRuntimeId,
  DelegatedWorkHost,
} from "../delegated-work/mod.ts";
import { log } from "../log.ts";

/**
 * Why a generation was invalidated. Replaces the old `preserveCommandQueue` /
 * `preserveInFlight` option bag with an explicit reason that the machine
 * interprets structurally.
 *
 * - `settings-change`: a same-binding settings mutation (e.g. `/model`).
 *   Queued commands survive so acknowledged order is preserved; a
 *   same-candidate creation is preserved so the replacement runner can
 *   register without re-reserving.
 * - `binding-change`: the binding rotated (e.g. `/new`, `/resume`, project
 *   move). All queued work and in-flight creations are dropped.
 * - `shutdown`: process shutdown. Everything is fenced; admission is closed.
 */
export type InvalidationReason = "settings-change" | "binding-change" | "shutdown";

/** Current generation phase within the machine. */
export type MachinePhase = "idle" | "preparing" | "active";

/**
 * Authority axis for an epoch ticket (decision 0046).
 *
 * - `"runtime"` — the machine's monotonic generation. Captured by prompts,
 *   steers, and scheduled turns. Bumped on every registration, creation
 *   reservation, and invalidation.
 * - `"binding"` — a separate monotonic counter. Captured by lifecycle
 *   commands. Bumped only on binding-change and shutdown, so same-binding
 *   settings invalidation preserves acknowledged command order.
 */
export type TicketAxis = "runtime" | "binding";

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

// ─── internal helpers ────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
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

class DelegatedInvalidationFailure extends Error {
  readonly runtimeId: ConversationRuntimeId;

  constructor(runtimeId: ConversationRuntimeId, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DelegatedInvalidationFailure";
    this.runtimeId = runtimeId;
    this.cause = cause;
  }
}

function flattenFailures(error: unknown, failures: unknown[]): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) flattenFailures(nested, failures);
    return;
  }
  failures.push(error);
}

// ─── queue ───────────────────────────────────────────────────────────

interface QueueEntry {
  readonly id: number;
  readonly isPrompt: boolean;
  started: boolean;
  cancelled: boolean;
  /** Queue epoch captured at schedule time. Entries from a fenced epoch are
   * invisible to the `hasPromptWork` / `isPromptPending` / `isCommandPending`
   * accessors. */
  readonly queueEpoch: number;
  readonly isCurrent: () => boolean;
  readonly run: (isCurrent: () => boolean) => Promise<void>;
  readonly onError: (err: unknown) => Promise<void> | void;
  readonly onStart?: () => void;
  readonly onFenced?: () => void;
  readonly onSettled?: () => void;
  /** Resolved by the serial executor when this entry has settled. */
  resolveSettled: () => void;
  /** Resolves when this entry has settled (success, error, or fenced). */
  readonly settled: Promise<void>;
}

// ─── drain ───────────────────────────────────────────────────────────

/** A prior generation whose disposal is still draining. */
interface DrainingGeneration {
  readonly generation: number;
  readonly promise: Promise<void>;
  readonly runtimeIds: ConversationRuntimeId[];
}

// ─── machine ─────────────────────────────────────────────────────────

export interface RuntimeMachineDeps {
  readonly conversationId: ConversationId;
  readonly delegatedWorkHost: DelegatedWorkHost;
  readonly externalAgentRunner?: ExternalAgentRunner;
  /** Process-level admission gate. The machine reads it at commit points. */
  readonly isAdmissionOpen: () => boolean;
}

/**
 * One per-conversation runtime machine. Owns admission, generation identity,
 * queueing, and disposal for a single Conversation.
 *
 * The machine is a **current generation** (idle / preparing / active) plus a
 * **drain set** of prior generations whose disposal is still settling. A
 * replacement creation may be reserved while a prior generation drains — the
 * two coexist as distinct generations distinguished by monotonic epoch.
 *
 * Authority is held as the `generation` field (the runtime epoch). Every
 * admitted work unit captures the epoch at admission; the serial executor
 * compares it at the commit point before and after the work's await. This is
 * the `assertCurrent` / `awaitCurrent` discipline generalized to the kernel
 * boundary.
 *
 * Legal transitions (every other transition throws):
 *
 *   idle      → preparing   reserveCreation
 *   preparing → preparing   reserveCreation (newer generation supersedes)
 *   preparing → active      registerSurfaceRuntime / registerInternalRuntime
 *   idle      → active      registerInternalRuntime
 *   active    → active      registerInternalRuntime (re-register internal)
 *   active    → preparing   invalidate("settings-change", preserveCreation)
 *   active    → idle        invalidate("binding-change" | "shutdown")
 *   preparing → idle        invalidate("binding-change" | "shutdown")
 *   idle      → idle        invalidate (no-op)
 *
 * Internal runtimes (dreaming) are machines whose tickets are always current
 * until disposed: `isInternal` is set at registration and the epoch ticket
 * check is skipped for internal work.
 */
export class RuntimeMachine {
  // ── generation / phase ──
  private generation = 0;
  private bindingEpoch = 0;
  private phase: MachinePhase = "idle";

  // ── current generation state ──
  private runner: AgentRunner | undefined;
  private surfaceId: SurfaceId | undefined;
  private runtimeId: ConversationRuntimeId | undefined;
  private skillContext: RuntimeSkillContext | undefined;
  private isInternal = false;
  private creation: RuntimeCreation | undefined;

  // ── queue (explicit entry list + serial executor) ──
  private queue: QueueEntry[] = [];
  private queueRunning = false;
  private queueIdleDeferred: Deferred<void> | undefined;
  private queueEntryIdCounter = 0;
  /**
   * Bumped each time the queue is fenced (binding-change or shutdown
   * invalidation). Entries capture the epoch at schedule time; the
   * `hasPromptWork` / `isPromptPending` / `isCommandPending` accessors only
   * count entries from the current epoch, so a started entry that is still
   * draining after invalidation is invisible to callers — matching the old
   * behavior where queue metadata was deleted synchronously.
   */
  private queueEpoch = 0;

  // ── drain set (overlapping generations) ──
  private drain = new Set<DrainingGeneration>();
  private pendingDelegatedInvalidations = new Set<ConversationRuntimeId>();

  private readonly deps: RuntimeMachineDeps;

  constructor(deps: RuntimeMachineDeps) {
    this.deps = deps;
  }

  // ── epoch / phase ──────────────────────────────────────────────────

  /** Monotonic per-conversation generation (runtime epoch). */
  get epoch(): number {
    return this.generation;
  }

  get currentPhase(): MachinePhase {
    return this.phase;
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  // ── epoch tickets (decision 0046) ──────────────────────────────────

  /**
   * Capture the current epoch for one authority axis. The returned value is
   * compared by {@link isEpochCurrent} at commit points — before and after
   * awaits that cross the kernel boundary.
   *
   * - `"runtime"`: the machine's monotonic generation. Bumped on every
   *   registration, creation reservation, and invalidation. Used for prompts,
   *   steers, and scheduled turns.
   * - `"binding"`: a separate monotonic counter. Bumped only on
   *   binding-change and shutdown invalidation. Used for lifecycle commands,
   *   so same-binding settings invalidation preserves acknowledged command
   *   order while a binding change drops queued commands.
   */
  captureEpoch(axis: TicketAxis): number {
    return axis === "runtime" ? this.generation : this.bindingEpoch;
  }

  /**
   * True when the captured epoch still matches the current epoch for the
   * given axis. This is the single helper that replaces the scattered
   * `isCurrent`-flavored authority checks at the dispatcher seam.
   */
  isEpochCurrent(axis: TicketAxis, epoch: number): boolean {
    return this.captureEpoch(axis) === epoch;
  }

  // ── runner access ──────────────────────────────────────────────────

  getRunner(): AgentRunner | null {
    return this.runner ?? null;
  }

  hasRunner(): boolean {
    return this.runner !== undefined;
  }

  isRegisteredRunner(runner: AgentRunner): boolean {
    return this.runner === runner;
  }

  isInternalRuntime(): boolean {
    return this.isInternal;
  }

  /**
   * True when the conversation has a registered runner, an in-flight creation
   * (excluding the given one), or pending delegated invalidations. Used by
   * the host's `hasRuntime` port method.
   */
  hasRuntime(excludeCreation?: Promise<AgentRunner>): boolean {
    if (this.runner !== undefined) return true;
    if (this.creation !== undefined && this.creation.promise !== excludeCreation) return true;
    if (this.pendingDelegatedInvalidations.size > 0) return true;
    return false;
  }

  surfaceIdFor(): SurfaceId | undefined {
    return this.surfaceId;
  }

  runtimeIdFor(): ConversationRuntimeId | undefined {
    return this.runtimeId;
  }

  skillContextFor(): RuntimeSkillContext | undefined {
    return this.skillContext;
  }

  // ── creation ───────────────────────────────────────────────────────

  getCreation(): RuntimeCreation | undefined {
    return this.creation;
  }

  /**
   * Reserve a new runtime construction. Transitions `idle → preparing` or
   * `preparing → preparing` (the old creation is fenced and its generation
   * enters the drain set conceptually — the old creation's promise is simply
   * forgotten; the caller's `isCurrentCreation` check will fail).
   */
  reserveCreation(surfaceId: SurfaceId, settingsFingerprint: string): RuntimeCreation {
    if (!this.deps.isAdmissionOpen()) {
      throw new Error("conversation runtime admission is closed");
    }
    this.nextGeneration();
    const control = deferred<AgentRunner>(true);
    const completion = deferred<void>();
    let creation!: RuntimeCreation;
    const complete = (): void => {
      completion.resolve(undefined);
      if (this.creation === creation) {
        this.creation = undefined;
      }
    };
    creation = {
      conversationId: this.deps.conversationId,
      promise: control.promise,
      completion: completion.promise,
      surfaceId,
      settingsFingerprint,
      resolve: control.resolve,
      reject: control.reject,
      complete,
    };
    this.creation = creation;
    this.transitionTo("preparing", "reserveCreation");
    return creation;
  }

  isCurrentCreation(promise: Promise<AgentRunner>): boolean {
    return this.creation?.promise === promise;
  }

  finishCreation(promise: Promise<AgentRunner>, creation: RuntimeCreation): void {
    creation.complete();
    if (this.creation?.promise === promise) {
      this.creation = undefined;
    }
  }

  // ── registration ───────────────────────────────────────────────────

  registerSurfaceRuntime(
    runner: AgentRunner,
    registration: SurfaceRuntimeRegistration,
  ): void {
    if (!this.deps.isAdmissionOpen()) {
      throw new Error("conversation runtime admission is closed");
    }
    if (this.drain.size > 0) {
      throw new Error(
        `cannot register runtime for ${this.deps.conversationId}: a prior-generation disposal is still active`,
      );
    }
    if (this.pendingDelegatedInvalidations.size > 0) {
      throw new Error(
        `cannot register runtime for ${this.deps.conversationId}: delegated work invalidation is still pending`,
      );
    }
    if (this.runner !== undefined) {
      throw new Error(`Conversation runtime already registered for ${this.deps.conversationId}`);
    }
    if (this.isInternal) {
      throw new Error(`Conversation ${this.deps.conversationId} is reserved by an internal runtime`);
    }
    this.nextGeneration();
    this.runner = runner;
    this.surfaceId = registration.surfaceId;
    this.runtimeId = registration.runtimeId;
    this.skillContext = registration.skillContext;
    this.isInternal = false;
    this.transitionTo("active", "registerSurfaceRuntime");
  }

  registerInternalRuntime(runner: AgentRunner): void {
    if (!this.deps.isAdmissionOpen()) {
      throw new Error("conversation runtime admission is closed");
    }
    if (this.drain.size > 0) {
      throw new Error(
        `cannot register internal runtime for ${this.deps.conversationId}: a prior-generation disposal is still active`,
      );
    }
    if (this.pendingDelegatedInvalidations.size > 0) {
      throw new Error(
        `cannot register internal runtime for ${this.deps.conversationId}: delegated work invalidation is still pending`,
      );
    }
    if (this.runner !== undefined && !this.isInternal) {
      throw new Error(`cannot reuse Surface-backed runtime ${this.deps.conversationId} for an internal turn`);
    }
    this.nextGeneration();
    this.runner = runner;
    this.isInternal = true;
    this.transitionTo("active", "registerInternalRuntime");
  }

  // ── queue ──────────────────────────────────────────────────────────

  /**
   * Enqueue work onto the serial executor. Returns `false` when admission is
   * closed; the work is not enqueued.
   *
   * The queue is an explicit entry list. Cancelling a queued entry removes it
   * from the list — the serial executor never reaches it and the runner is
   * never touched. This is structurally impossible to reach the runner on
   * cancel, unlike the old promise-chain where a cancelled entry's execute
   * function still ran.
   */
  schedule(
    isCurrent: () => boolean,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    options: {
      isPrompt?: boolean;
      onStart?: () => void;
      onFenced?: () => void;
      onSettled?: () => void;
    } = {},
  ): boolean {
    if (!this.deps.isAdmissionOpen()) {
      log.info("runtime work rejected after admission closed", {
        conversationId: this.deps.conversationId,
      });
      return false;
    }
    const settledControl = deferred<void>(true);
    const entry: QueueEntry = {
      id: this.queueEntryIdCounter++,
      isPrompt: options.isPrompt ?? true,
      started: false,
      cancelled: false,
      queueEpoch: this.queueEpoch,
      isCurrent,
      run,
      onError,
      onStart: options.onStart,
      onFenced: options.onFenced,
      onSettled: options.onSettled,
      resolveSettled: settledControl.resolve,
      settled: settledControl.promise,
    };
    this.queue.push(entry);
    this.ensureQueueIdlePromise();
    void this.pump();
    return true;
  }

  isCommandPending(): boolean {
    return this.queue.some((entry) => !entry.isPrompt && entry.queueEpoch === this.queueEpoch);
  }

  isPromptPending(): boolean {
    return this.queue.some(
      (entry) =>
        entry.isPrompt &&
        entry.queueEpoch === this.queueEpoch &&
        !entry.started &&
        !entry.cancelled,
    );
  }

  hasPromptWork(): boolean {
    return this.queue.some(
      (entry) => entry.isPrompt && entry.queueEpoch === this.queueEpoch,
    );
  }

  /**
   * Cancel the last queued-but-not-started prompt entry. Removes it from the
   * queue list — the serial executor will never process it and the runner is
   * never touched. Returns `true` when a pending prompt was found.
   */
  cancelPending(): boolean {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i]!;
      if (entry.isPrompt && !entry.started && !entry.cancelled) {
        entry.cancelled = true;
        this.queue.splice(i, 1);
        this.safeCallback(entry.onFenced, entry.id);
        this.safeCallback(entry.onSettled, entry.id);
        entry.resolveSettled();
        this.checkQueueIdle();
        return true;
      }
    }
    return false;
  }

  // ── serial executor ────────────────────────────────────────────────

  private ensureQueueIdlePromise(): void {
    if (this.queueIdleDeferred === undefined) {
      this.queueIdleDeferred = deferred<void>(true);
    }
  }

  private checkQueueIdle(): void {
    if (this.queue.length === 0 && !this.queueRunning && this.queueIdleDeferred) {
      this.queueIdleDeferred.resolve(undefined);
      this.queueIdleDeferred = undefined;
    }
  }

  /**
   * Process queue entries one at a time. Only one pump runs at a time
   * (guarded by `queueRunning`). Between entries the code is synchronous —
   * no other code can interleave — so removing an entry via cancel or
   * invalidation is always observed before the next entry starts.
   */
  private async pump(): Promise<void> {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0];
        if (entry === undefined) break;

        // Fence entries that were cancelled or that haven't started after
        // admission closed. Started entries are allowed to drain.
        if (entry.cancelled || (!entry.started && !this.deps.isAdmissionOpen())) {
          this.queue.shift();
          this.safeCallback(entry.onFenced, entry.id);
          this.safeCallback(entry.onSettled, entry.id);
          entry.resolveSettled();
          continue;
        }

        // Commit point: check epoch authority before starting.
        if (!entry.isCurrent()) {
          this.queue.shift();
          this.safeCallback(entry.onFenced, entry.id);
          this.safeCallback(entry.onSettled, entry.id);
          entry.resolveSettled();
          continue;
        }

        entry.started = true;
        this.safeCallback(entry.onStart, entry.id);
        try {
          await entry.run(entry.isCurrent);
          // Post-await commit point: if the epoch bumped during the await,
          // fence the result.
          if (!entry.isCurrent()) {
            this.safeCallback(entry.onFenced, entry.id);
          }
        } catch (err) {
          if (!entry.isCurrent()) {
            this.safeCallback(entry.onFenced, entry.id);
          } else {
            try {
              await entry.onError(err);
            } catch (handlerErr) {
              log.error("runtime queue error handler failed", {
                conversationId: this.deps.conversationId,
                error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
              });
            }
          }
        }
        this.queue.shift();
        this.safeCallback(entry.onSettled, entry.id);
        entry.resolveSettled();
      }
    } finally {
      this.queueRunning = false;
      this.checkQueueIdle();
    }
  }

  /**
   * Invoke a queue callback, logging and swallowing any throw so a faulty
   * callback cannot leak a ticket or cause a double-execution by leaving the
   * entry in an inconsistent state.
   */
  private safeCallback(fn: (() => void) | undefined, entryId: number): void {
    if (!fn) return;
    try {
      fn();
    } catch (error) {
      log.error("runtime queue callback threw", {
        conversationId: this.deps.conversationId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Resolve when the queue is empty and the executor is not running. */
  queueSettled(): Promise<void> {
    if (this.queue.length === 0 && !this.queueRunning) {
      return Promise.resolve();
    }
    this.ensureQueueIdlePromise();
    return this.queueIdleDeferred!.promise;
  }

  // ── invalidation / disposal ────────────────────────────────────────

  /**
   * Invalidate the current generation. The runner and creation are fenced
   * synchronously; physical cleanup (runner dispose, delegated invalidation,
   * external-agent cancellation) runs asynchronously and enters the drain
   * set.
   *
   * - `settings-change`: queued commands are preserved; if
   *   `preserveCreationPromise` matches the current creation's promise, the
   *   creation is preserved too.
   * - `binding-change`: all queued work and the creation are dropped.
   * - `shutdown`: same as `binding-change` but also fences entries that
   *   haven't started yet (admission is closed by the host before calling
   *   this).
   *
   * Deduplication is generation-aware: a second call for the same generation
   * shares the in-flight disposal promise. A call after a newer generation
   * started begins a fresh disposal.
   */
  invalidate(
    reason: InvalidationReason,
    preserveCreationPromise?: Promise<AgentRunner>,
  ): Promise<void> {
    const currentGeneration = this.generation;

    // Apply the fence first, even if a disposal is already in flight for this
    // generation. A later stronger call can revoke a creation or queue that
    // an earlier call deliberately preserved.
    const priorRunner = this.runner;
    const priorRuntimeId = this.runtimeId;
    const hadCreation = this.creation !== undefined;
    const preservesCreation =
      reason === "settings-change" &&
      preserveCreationPromise !== undefined &&
      this.creation?.promise === preserveCreationPromise;

    if (priorRuntimeId !== undefined) {
      this.pendingDelegatedInvalidations.add(priorRuntimeId);
    }

    // Clear current generation state.
    this.runner = undefined;
    this.surfaceId = undefined;
    this.runtimeId = undefined;
    this.skillContext = undefined;
    this.isInternal = false;

    if (!preservesCreation) {
      this.creation = undefined;
    }

    // Queue handling: settings-change preserves the queue; binding-change
    // and shutdown drop it.
    if (reason !== "settings-change") {
      this.fenceQueue();
    }

    // The machine goes idle (or stays preparing if the creation is preserved).
    if (preservesCreation) {
      this.transitionTo("preparing", "invalidate-preserve");
    } else {
      this.transitionTo("idle", "invalidate-drop");
    }

    // After fencing, check if a disposal is already in flight for this
    // generation. If so, share its promise — the fence above has already
    // applied the stronger semantics. Bump the epoch so tickets captured
    // before the stronger fence become stale.
    for (const draining of this.drain) {
      if (draining.generation === currentGeneration) {
        this.bumpEpochs(reason);
        return draining.promise;
      }
    }

    // Also deduplicate by runtime identity: a consecutive invalidation
    // with no new runner but the same pending delegated invalidations is
    // a re-invocation of the same disposal. The epoch bump from the first
    // call already fenced stale tickets; the stronger fence above applied
    // its semantics (dropped creation/queue). Share the in-flight promise.
    if (priorRunner === undefined && this.pendingDelegatedInvalidations.size > 0) {
      const pendingIds = [...this.pendingDelegatedInvalidations];
      for (const draining of this.drain) {
        if (pendingIds.every((id) => draining.runtimeIds.includes(id))) {
          this.bumpEpochs(reason);
          return draining.promise;
        }
      }
    }

    // Nothing to drain — the machine was idle with no runner, no creation,
    // and no pending delegated invalidations. But the fence above may have
    // dropped a creation or fenced the queue. Bump the epoch so tickets
    // captured before the fence become stale, then return without creating
    // a spurious drain entry.
    if (priorRunner === undefined && this.pendingDelegatedInvalidations.size === 0) {
      const droppedCreation = hadCreation && !preservesCreation;
      const fencedQueue = reason !== "settings-change" && this.queue.length > 0;
      if (droppedCreation || fencedQueue) {
        this.bumpEpochs(reason);
      }
      return Promise.resolve();
    }

    // Bump epochs per decision 0046: the runtime epoch bumps on every
    // invalidation; the binding epoch bumps only on binding-change and
    // shutdown. Captured tickets from the prior epoch become stale
    // synchronously — commit-point comparison fences stale work before it
    // produces side effects.
    this.bumpEpochs(reason);

    // Start physical cleanup as a drain generation.
    const runtimeIds = [...this.pendingDelegatedInvalidations];
    const disposal = this.disposeGeneration(priorRunner, runtimeIds);
    const draining: DrainingGeneration = {
      generation: currentGeneration,
      promise: disposal,
      runtimeIds,
    };
    this.drain.add(draining);
    void disposal.then(
      () => this.drain.delete(draining),
      () => this.drain.delete(draining),
    );
    return disposal;
  }

  /**
   * Bump the runtime epoch on every invalidation and the binding epoch only
   * on binding-change and shutdown (decision 0046).
   */
  private bumpEpochs(reason: InvalidationReason): void {
    this.nextGeneration();
    if (reason !== "settings-change") {
      this.bindingEpoch += 1;
    }
  }

  /**
   * Fence all queued entries that haven't started and bump the queue epoch so
   * started entries from the old epoch become invisible to the
   * `hasPromptWork` / `isPromptPending` / `isCommandPending` accessors.
   * Started entries remain in the queue so the serial executor can drain
   * them; they are simply no longer counted as pending work.
   */
  private fenceQueue(): void {
    this.queueEpoch++;
    const remaining: QueueEntry[] = [];
    for (const entry of this.queue) {
      if (entry.started) {
        // Started entries drain; they are kept in the queue but are
        // invisible to accessors because their queueEpoch is now stale.
        remaining.push(entry);
      } else {
        entry.cancelled = true;
        this.safeCallback(entry.onFenced, entry.id);
        this.safeCallback(entry.onSettled, entry.id);
        entry.resolveSettled();
      }
    }
    this.queue = remaining;
    this.checkQueueIdle();
  }

  private async disposeGeneration(
    runner: AgentRunner | undefined,
    runtimeIds: ConversationRuntimeId[],
  ): Promise<void> {
    const delegatedFailures: unknown[] = [];
    const delegatedInvalidation = Promise.all(
      runtimeIds.map(async (runtimeId) => {
        try {
          await this.deps.delegatedWorkHost.invalidateRuntime(runtimeId);
          this.pendingDelegatedInvalidations.delete(runtimeId);
        } catch (error) {
          delegatedFailures.push(new DelegatedInvalidationFailure(runtimeId, error));
          log.error("delegated work invalidation failed in runtime disposal", {
            conversationId: this.deps.conversationId,
            runtimeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    let runnerError: unknown;
    let runnerFailed = false;
    if (runner) {
      try {
        await runner.dispose();
      } catch (error) {
        runnerFailed = true;
        runnerError = error;
        log.error("AgentRunner.dispose failed in runtime disposal", {
          conversationId: this.deps.conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await delegatedInvalidation;

    // External-agent cancellation with a bounded timeout.
    let externalTimer: ReturnType<typeof setTimeout> | undefined;
    const externalCancellation = this.deps.externalAgentRunner
      ? this.deps.externalAgentRunner.cancelBySession(this.deps.conversationId)
      : Promise.resolve();
    let externalCancellationTimedOut = false;
    let externalCancellationError: unknown;
    let externalCancellationFailed = false;
    const timeout = new Promise<void>((resolve) => {
      externalTimer = setTimeout(() => {
        externalCancellationTimedOut = true;
        log.warn("external-agent cancellation timed out in runtime disposal", {
          conversationId: this.deps.conversationId,
        });
        resolve();
      }, 10_000);
    });
    try {
      await Promise.race([externalCancellation, timeout]);
    } catch (error) {
      externalCancellationFailed = true;
      externalCancellationError = error;
      log.error("external-agent cancellation failed in runtime disposal", {
        conversationId: this.deps.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (externalTimer !== undefined) clearTimeout(externalTimer);
    }

    const failures: unknown[] = [];
    if (runnerFailed) failures.push(runnerError);
    failures.push(...delegatedFailures);
    if (externalCancellationTimedOut) {
      failures.push(new Error(`external-agent cancellation timed out for ${this.deps.conversationId}`));
    }
    if (externalCancellationFailed) failures.push(externalCancellationError);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Conversation runtime cleanup failed");
  }

  /**
   * Resolve once every in-progress disposal for this Conversation has settled.
   * A replacement generation awaits this before committing so a runner never
   * registers while a prior generation's cleanup is draining.
   *
   * If a delegated invalidation failed and remains pending, the retry path
   * runs the same cleanup again before allowing a replacement.
   */
  async awaitSettled(): Promise<void> {
    for (;;) {
      const active = [...this.drain];
      let activeFailure: unknown;
      if (active.length > 0) {
        try {
          await Promise.all(active.map((entry) => entry.promise));
        } catch (error) {
          activeFailure = error;
        }
      }
      if (this.pendingDelegatedInvalidations.size > 0) {
        // Let the drain observer remove its entry before retrying.
        await Promise.resolve();
        try {
          await this.invalidate("binding-change");
        } catch (error) {
          if (activeFailure !== undefined) {
            throw new AggregateError([activeFailure, error], "Conversation runtime cleanup failed");
          }
          throw error;
        }
        if (activeFailure !== undefined) throw activeFailure;
        continue;
      }
      if (activeFailure !== undefined) throw activeFailure;
      return;
    }
  }

  // ── shutdown ───────────────────────────────────────────────────────

  /**
   * Shutdown disposal for this machine. Called by the host after admission is
   * closed. Retries delegated invalidation once; persistent failure is
   * reported rather than spun.
   */
  async shutdown(): Promise<void> {
    // Capture the in-flight creation's completion before invalidating, so
    // shutdown waits for the caller to finishCreation even after the creation
    // is fenced.
    const creationCompletion = this.creation?.completion;

    // Always fence the current generation — the machine may be in
    // `preparing` with no runner or creation (e.g. a failed registration
    // left it in preparing after the creation was completed).
    void this.invalidate("shutdown");

    // Drain the queue first: started entries drain, unstarted entries are
    // fenced by the admission check in pump.
    await this.queueSettled();

    // Drain all disposals and retry pending delegated invalidations once.
    const attemptedPending = new Set<ConversationRuntimeId>();
    const failures: unknown[] = [];

    for (;;) {
      const drainPromises = [...this.drain].map((d) => d.promise);

      // Retry pending delegated invalidations that haven't been attempted.
      // Only retry when no drain is in flight — a drain in flight already
      // covers these IDs.
      const retryable = [...this.pendingDelegatedInvalidations].filter(
        (id) => !attemptedPending.has(id),
      );

      if (retryable.length > 0 && this.drain.size === 0) {
        // Mark as attempted before re-invalidating so a persistent failure
        // doesn't spin forever.
        retryable.forEach((id) => attemptedPending.add(id));
        void this.invalidate("shutdown");
        continue; // Re-capture drain promises with the new disposal
      }

      const promises: Promise<unknown>[] = [...drainPromises];
      if (creationCompletion) promises.push(creationCompletion);

      if (promises.length > 0) {
        const results = await Promise.allSettled(promises);
        for (const result of results) {
          if (result.status === "rejected") flattenFailures(result.reason, failures);
        }
      }

      // Yield so drain observers can remove settled entries.
      await Promise.resolve();

      if (
        this.runner === undefined &&
        this.creation === undefined &&
        this.drain.size === 0 &&
        this.queue.length === 0 &&
        this.pendingDelegatedInvalidations.size === 0
      ) {
        break;
      }

      // All retries exhausted but pending invalidations remain — report
      // them rather than spinning forever.
      if (retryable.length === 0 && this.drain.size === 0 && this.pendingDelegatedInvalidations.size > 0) {
        break;
      }
    }

    // Filter out delegated invalidation failures that have been recovered.
    const reportable = failures.filter(
      (f) =>
        !(f instanceof DelegatedInvalidationFailure) ||
        this.pendingDelegatedInvalidations.has(f.runtimeId),
    );
    if (reportable.length === 1) {
      throw reportable[0] instanceof Error ? reportable[0] : new Error(String(reportable[0]));
    }
    if (reportable.length > 1) {
      throw new AggregateError(reportable, "Conversation runtime shutdown failed");
    }
  }

  // ── transition guard ───────────────────────────────────────────────

  private transitionTo(target: MachinePhase, op: TransitionOp): void {
    const source = this.phase;
    if (!isLegalTransition(source, target, op)) {
      throw new Error(
        `illegal runtime machine transition for ${this.deps.conversationId}: ` +
          `${source} → ${target} via ${op}`,
      );
    }
    this.phase = target;
  }
}

// ─── transition table ────────────────────────────────────────────────

/** The operation triggering a phase transition. */
type TransitionOp =
  | "reserveCreation"
  | "registerSurfaceRuntime"
  | "registerInternalRuntime"
  | "invalidate-preserve"
  | "invalidate-drop";

/**
 * Legal transition table. Every transition not listed here is illegal and
 * throws with structured identity (conversation + source → target via op).
 *
 *   idle      → preparing   reserveCreation
 *   preparing → preparing   reserveCreation (newer generation supersedes)
 *   preparing → active      registerSurfaceRuntime / registerInternalRuntime
 *   idle      → active      registerInternalRuntime
 *   active    → active      registerInternalRuntime (re-register internal)
 *   active    → preparing   reserveCreation (replacement) / invalidate-preserve (settings-change)
 *   active    → idle        invalidate-drop (binding-change | shutdown)
 *   preparing → idle        invalidate-drop (binding-change | shutdown)
 *   idle      → idle        invalidate-drop (no-op)
 *
 * Notably illegal:
 *   idle → active via registerSurfaceRuntime (requires a creation first)
 *   active → active via registerSurfaceRuntime (runner already registered)
 *   preparing → preparing via invalidate-preserve (no runner to preserve from)
 */
function isLegalTransition(
  source: MachinePhase,
  target: MachinePhase,
  op: TransitionOp,
): boolean {
  // Same-phase is legal for re-entry ops.
  if (source === target) return true;

  switch (source) {
    case "idle":
      // idle → preparing via reserveCreation
      // idle → active via registerInternalRuntime only
      if (target === "preparing") return op === "reserveCreation";
      if (target === "active") return op === "registerInternalRuntime";
      return false;
    case "preparing":
      // preparing → active via registration
      // preparing → idle via invalidate-drop
      if (target === "active") {
        return op === "registerSurfaceRuntime" || op === "registerInternalRuntime";
      }
      if (target === "idle") return op === "invalidate-drop";
      return false;
    case "active":
      // active → preparing via reserveCreation (replacement) or invalidate-preserve
      // active → idle via invalidate-drop
      if (target === "preparing") {
        return op === "invalidate-preserve" || op === "reserveCreation";
      }
      if (target === "idle") return op === "invalidate-drop";
      return false;
  }
}

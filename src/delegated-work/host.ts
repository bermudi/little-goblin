import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseSurfaceId } from "../surface.ts";
import { boundedError, log } from "../log.ts";
import type { ConversationId } from "../sessions/types.ts";
import {
  DelegatedWorkRecordStore,
  parseDelegatedWorkRecord,
  type DelegatedWorkInvocation,
  type DelegatedWorkKind,
  type DelegatedWorkRecord,
} from "./store.ts";
import {
  asConversationRuntimeId,
  type AttachedDelegatedWorkOwnership,
  type AttachedWorkAdapter,
  type DelegatedWorkOwnership,
  type DelegatedWorkRegistration,
  type ConversationRuntimeId,
  type DurableDelegatedWorkOwnership,
  type DurableWorkRegistration,
} from "./types.ts";

/** A rejected registration cannot be mistaken for a run that was cancelled. */
export class DelegatedWorkRuntimeInvalidatedError extends Error {
  readonly runtimeId: ConversationRuntimeId;

  constructor(runtimeId: ConversationRuntimeId) {
    super(`Conversation runtime ${runtimeId} has been invalidated`);
    this.name = "DelegatedWorkRuntimeInvalidatedError";
    this.runtimeId = runtimeId;
  }
}

/** An explicit owner cancellation fences the whole attached invocation epoch. */
export class DelegatedWorkEpochCancelledError extends Error {
  readonly ownershipEpochId: string;

  constructor(ownershipEpochId: string) {
    super(`Delegated work epoch ${ownershipEpochId} has been cancelled`);
    this.name = "DelegatedWorkEpochCancelledError";
    this.ownershipEpochId = ownershipEpochId;
  }
}

interface RegistrationEntry {
  readonly runId: string;
  readonly ownership: DelegatedWorkOwnership;
  readonly ready: Promise<AttachedWorkAdapter | null>;
  resolveReady: (adapter: AttachedWorkAdapter | null) => void;
  adapter: AttachedWorkAdapter | null;
  fenced: boolean;
  released: boolean;
}

function validateOwnership(ownership: DelegatedWorkOwnership): void {
  if (ownership.lifetime !== "attached" && ownership.lifetime !== "durable") {
    throw new Error("Delegated work requires an attached or durable lifetime");
  }
  if (ownership.ownerConversationId.length === 0) {
    throw new Error("Delegated work requires an owner Conversation");
  }
  if (ownership.runtimeId.length === 0) {
    throw new Error("Delegated work requires a runtime identity");
  }
  if (ownership.ownershipEpochId.length === 0) {
    throw new Error("Delegated work requires an ownership epoch");
  }
  // SurfaceId is a branded type inside the process, but this is still a deep
  // module boundary. Validate it rather than trusting a cast from a caller.
  parseSurfaceId(ownership.originSurfaceId);
  if (ownership.executionEnvironment.kind === "project") {
    if (
      ownership.executionEnvironment.projectRoot.length === 0 ||
      !isAbsolute(ownership.executionEnvironment.projectRoot)
    ) {
      throw new Error("Delegated work requires an absolute project root");
    }
  } else if (ownership.executionEnvironment.kind !== "personal") {
    throw new Error("Delegated work has an invalid execution environment");
  }
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
 * Deep lifecycle boundary for delegated work.
 *
 * This first slice intentionally has one adapter kind (attached Pi
 * subagents), but the ownership/fence/quiescence contract is generic. Runtime
 * invalidation is the only lifecycle operation used by Conversation runtime
 * disposal; callers do not enumerate subagent instances or call their cancel
 * methods directly.
 */
export class DelegatedWorkHost {
  private readonly registrations = new Map<string, RegistrationEntry>();
  private readonly invalidatedRuntimes = new Set<ConversationRuntimeId>();
  private readonly invalidations = new Map<ConversationRuntimeId, Promise<void>>();
  /** Explicit cancellation fences an epoch without invalidating its runtime. */
  private readonly cancelledEpochs = new Set<string>();
  /** Filesystem implementation; all callers use this host's lifecycle API. */
  private readonly recordStore: DelegatedWorkRecordStore;
  private reconciled = false;

  constructor(home: string) {
    this.recordStore = new DelegatedWorkRecordStore(home);
    this.reconcileStartup();
  }

  /** Create a runtime identity for a newly assembled Conversation runtime. */
  static newRuntimeId(): ConversationRuntimeId {
    return asConversationRuntimeId(randomUUID());
  }

  /**
   * Reserve attached work before its adapter creates execution state. A
   * runtime fence therefore wins before metadata, a Pi session, or a
   * descendant can exist.
   */
  reserveAttached(
    runId: string,
    ownership: AttachedDelegatedWorkOwnership,
  ): DelegatedWorkRegistration<AttachedDelegatedWorkOwnership> {
    if (runId.length === 0) throw new Error("Delegated work run id must not be empty");
    validateOwnership(ownership);
    if (ownership.lifetime !== "attached") {
      throw new Error("DelegatedWorkHost only accepts attached registrations in this slice");
    }
    if (this.invalidatedRuntimes.has(ownership.runtimeId)) {
      throw new DelegatedWorkRuntimeInvalidatedError(ownership.runtimeId);
    }
    if (this.cancelledEpochs.has(ownership.ownershipEpochId)) {
      throw new DelegatedWorkEpochCancelledError(ownership.ownershipEpochId);
    }
    if (this.registrations.has(runId)) {
      throw new Error(`Delegated work run ${runId} is already registered`);
    }
    return this.createRegistration(runId, ownership);
  }

  /**
   * Reserve durable work before its adapter creates execution state.
   *
   * Durable registrations (decision 0036) are not owned by a Conversation
   * runtime: the captured runtime identity is spawn-time provenance, so a
   * prior invalidation of that runtime must not block the reservation, and
   * later runtime invalidation must not fence, cancel, or retarget the entry.
   * Only explicit epoch cancellation (owner cancellation) fences it here.
   */
  reserveDurable(
    runId: string,
    ownership: DurableDelegatedWorkOwnership,
  ): DurableWorkRegistration {
    if (runId.length === 0) throw new Error("Delegated work run id must not be empty");
    validateOwnership(ownership);
    if (ownership.lifetime !== "durable") {
      throw new Error("DelegatedWorkHost durable reservations require durable ownership");
    }
    if (this.cancelledEpochs.has(ownership.ownershipEpochId)) {
      throw new DelegatedWorkEpochCancelledError(ownership.ownershipEpochId);
    }
    if (this.registrations.has(runId)) {
      throw new Error(`Delegated work run ${runId} is already registered`);
    }
    return this.createRegistration(runId, ownership);
  }

  /**
   * Shared registration mechanics. Runtime-invalidation fencing applies only
   * to attached ownership; durable entries in the same map are excluded from
   * invalidation by the `invalidateRuntime` filter.
   */
  private createRegistration<O extends DelegatedWorkOwnership>(
    runId: string,
    ownership: O,
  ): DelegatedWorkRegistration<O> {
    let resolveReady!: (adapter: AttachedWorkAdapter | null) => void;
    const ready = new Promise<AttachedWorkAdapter | null>((resolve) => {
      resolveReady = resolve;
    });
    // This is an internal coordination promise. It always settles even when no
    // adapter was attached: a setup failure calls release, and a runtime fence
    // resolves ready to null via fenceEntries.
    ready.catch(() => {});
    const entry: RegistrationEntry = {
      runId,
      ownership,
      ready,
      resolveReady,
      adapter: null,
      fenced: false,
      released: false,
    };
    this.registrations.set(runId, entry);

    return {
      runId,
      ownership,
      get fenced() {
        return entry.fenced;
      },
      attach: (adapter) => {
        if (entry.released) throw new Error(`Delegated work run ${runId} was released`);
        const runtimeInvalidated = ownership.lifetime === "attached" &&
          this.invalidatedRuntimes.has(ownership.runtimeId);
        const epochCancelled = this.cancelledEpochs.has(ownership.ownershipEpochId);
        if (entry.fenced || runtimeInvalidated || epochCancelled) {
          entry.fenced = true;
          adapter.fence();
          entry.resolveReady(null);
          if (runtimeInvalidated) {
            throw new DelegatedWorkRuntimeInvalidatedError(ownership.runtimeId);
          }
          throw new DelegatedWorkEpochCancelledError(ownership.ownershipEpochId);
        }
        entry.adapter = adapter;
        entry.resolveReady(adapter);
      },
      release: () => {
        if (entry.released) return;
        entry.released = true;
        if (entry.adapter === null) entry.resolveReady(null);
        if (this.registrations.get(runId) === entry) this.registrations.delete(runId);
      },
    };
  }

  /**
   * Fence one runtime synchronously, then stop every attached registration in
   * that runtime. Durable registrations are excluded: their captured runtime
   * identity is spawn-time provenance (decision 0036), so runtime invalidation
   * must not cancel, fence, or retarget them. There is deliberately no
   * timeout-success path: a failed quiescence proof is returned to lifecycle
   * orchestration as a failure.
   */
  invalidateRuntime(runtimeId: ConversationRuntimeId): Promise<void> {
    const prior = this.invalidations.get(runtimeId);
    if (prior !== undefined) return prior;

    this.invalidatedRuntimes.add(runtimeId);
    const entries = [...this.registrations.values()].filter(
      (entry) =>
        entry.ownership.lifetime === "attached" && entry.ownership.runtimeId === runtimeId,
    );
    this.fenceEntries(entries);

    const invalidation = this.cancelEntries(`runtime ${runtimeId} invalidation`, entries);
    this.invalidations.set(runtimeId, invalidation);
    // Do not leave a rejected promise permanently poisoning a runtime id. The
    // fence remains in force, while a caller may retry quiescence explicitly.
    void invalidation.catch(() => {
      if (this.invalidations.get(runtimeId) === invalidation) this.invalidations.delete(runtimeId);
    });
    return invalidation;
  }

  /** Fence all entries before any asynchronous cancellation begins. */
  private fenceEntries(entries: readonly RegistrationEntry[]): void {
    for (const entry of entries) {
      entry.fenced = true;
      entry.adapter?.fence();
      // A reservation that never attached cannot produce an adapter after the
      // fence. Settle `ready` so `cancelEntries` cannot wait forever.
      if (entry.adapter === null) entry.resolveReady(null);
    }
  }

  /**
   * Explicitly cancel all attached work owned by one Conversation. This is
   * distinct from runtime invalidation: the runtime remains usable for later
   * invocations, but every currently registered invocation epoch is fenced so
   * a late recursive spawn cannot escape the owner's cancellation.
   */
  cancelByConversation(ownerConversationId: ConversationId): Promise<void> {
    if (ownerConversationId.length === 0) {
      throw new Error("Delegated work cancellation requires an owner Conversation");
    }
    const entries = [...this.registrations.values()].filter(
      (entry) => entry.ownership.ownerConversationId === ownerConversationId,
    );
    for (const entry of entries) {
      this.cancelledEpochs.add(entry.ownership.ownershipEpochId);
    }
    this.fenceEntries(entries);
    return this.cancelEntries(`owner ${ownerConversationId} cancellation`, entries);
  }

  private async cancelEntries(
    scope: string,
    entries: readonly RegistrationEntry[],
  ): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all(entries.map(async (entry) => {
      const entryFailures: unknown[] = [];
      try {
        // A reservation can be observed without an adapter in a setup race or
        // after a runtime fence. Waiting for readiness lets the host distinguish
        // setup failure (release -> null) and fence settlement (resolveReady ->
        // null) from a real adapter that must be quiesced.
        const adapter = entry.adapter ?? await entry.ready;
        if (adapter === null) return;
        try {
          await adapter.cancel();
        } catch (error) {
          entryFailures.push(error);
          log.error("delegated work cancellation failed", {
            runId: entry.runId,
            scope,
            ...boundedError(error),
          });
        }
        try {
          await adapter.quiesce();
        } catch (error) {
          entryFailures.push(error);
          log.error("delegated work quiescence failed", {
            runId: entry.runId,
            scope,
            ...boundedError(error),
          });
        }
        if (entryFailures.length === 0) {
          this.releaseEntry(entry);
        }
      } catch (error) {
        entryFailures.push(error);
        log.error("delegated work registration failed", {
          runId: entry.runId,
          scope,
          ...boundedError(error),
        });
      }
      failures.push(...entryFailures);
    }));

    const failure = combineFailures(failures, `Delegated work ${scope} did not quiesce`);
    if (failure !== null) throw failure;
  }

  private releaseEntry(entry: RegistrationEntry): void {
    if (entry.released) return;
    entry.released = true;
    if (this.registrations.get(entry.runId) === entry) this.registrations.delete(entry.runId);
  }

  /** Exposed for diagnostics/tests without exposing adapter mechanics. Only
   * attached registrations are counted: they are the work a runtime
   * invalidation fences. */
  registeredForRuntime(runtimeId: ConversationRuntimeId): number {
    return [...this.registrations.values()].filter(
      (entry) =>
        entry.ownership.lifetime === "attached" && entry.ownership.runtimeId === runtimeId,
    ).length;
  }

  /**
   * Create a new delegated-run record with its first invocation.
   *
   * The returned run directory is where kind-specific state (e.g., the Pi
   * session file) must live. The invocation's lifetime comes from the
   * ownership: attached for blocking work, durable for background work.
   */
  createRecord(
    runId: string,
    kind: DelegatedWorkKind,
    name: string | null,
    depth: number,
    ownership: DelegatedWorkOwnership,
  ): { record: DelegatedWorkRecord; runDir: string } {
    return this.recordStore.createRecord(runId, kind, name, depth, ownership);
  }

  /**
   * Append a new attached invocation to an existing record.
   *
   * Revival never patches a running invocation back to running; it always adds
   * a new entry that resumes the persisted session in the same run directory.
   */
  appendAttachedRevival(
    runId: string,
    ownership: AttachedDelegatedWorkOwnership,
  ): { record: DelegatedWorkRecord; runDir: string } {
    return this.recordStore.appendInvocation(runId, ownership);
  }

  /** Return the run directory where the execution host keeps kind-specific state. */
  runDir(runId: string): string {
    return this.recordStore.runDir(runId);
  }

  /** Close a successfully settled invocation; delivery remains explicitly pending. */
  completeInvocation(runId: string, index: number, text: string): DelegatedWorkRecord {
    return this.recordStore.closeInvocation(
      runId,
      index,
      "completed",
      { kind: "success", text },
      "pending",
    );
  }

  /** Close an execution failure. Failed work is never automatically delivered. */
  failInvocation(runId: string, index: number, errorMessage: string): DelegatedWorkRecord {
    return this.recordStore.closeInvocation(
      runId,
      index,
      "error",
      { kind: "error", errorMessage },
      "suppressed",
    );
  }

  /** Close work cancelled by its owner or by runtime invalidation. */
  cancelInvocation(runId: string, index: number): DelegatedWorkRecord {
    return this.recordStore.closeInvocation(runId, index, "cancelled", null, "suppressed");
  }

  /** Mark a started-but-never-executed invocation interrupted. */
  interruptInvocation(runId: string, index: number): DelegatedWorkRecord {
    return this.recordStore.closeInvocation(runId, index, "interrupted", null, "suppressed");
  }

  /** Suppress a terminal result whose owning runtime can no longer accept it. */
  suppressDelivery(runId: string, index: number): DelegatedWorkRecord {
    const { record, invocation } = this.requireInvocation(runId, index);
    if (invocation.status === "running") {
      throw new Error(`Cannot suppress delivery for invocation ${index} of ${runId}: still running`);
    }
    if (invocation.deliveryState === "suppressed") return record;
    if (invocation.deliveryState === "delivered") {
      throw new Error(
        `Cannot suppress delivery for invocation ${index} of ${runId}: already delivered`,
      );
    }
    return this.recordStore.setDeliveryState(runId, index, "suppressed");
  }

  /** Acknowledge that the blocking caller accepted the terminal result. */
  acknowledgeDelivery(runId: string, index: number): DelegatedWorkRecord {
    const { record, invocation } = this.requireInvocation(runId, index);
    if (invocation.status !== "completed") {
      throw new Error(
        `Cannot acknowledge delivery for invocation ${index} of ${runId}: status is ${invocation.status}`,
      );
    }
    if (invocation.deliveryState === "delivered") return record;
    if (invocation.deliveryState !== "pending") {
      throw new Error(
        `Cannot acknowledge delivery for invocation ${index} of ${runId}: delivery is ${invocation.deliveryState}`,
      );
    }
    return this.recordStore.setDeliveryState(runId, index, "delivered");
  }

  private requireInvocation(
    runId: string,
    index: number,
  ): { record: DelegatedWorkRecord; invocation: DelegatedWorkInvocation } {
    const record = this.recordStore.require(runId);
    const invocation = record.invocations[index];
    if (invocation === undefined) {
      throw new Error(`Invocation index ${index} out of bounds for record ${runId}`);
    }
    return { record, invocation };
  }

  /** Load a record if it exists; malformed records fail loudly. */
  loadRecord(runId: string): DelegatedWorkRecord | null {
    return this.recordStore.load(runId);
  }

  /** List known run ids from the host-owned store. */
  listRecordIds(): string[] {
    return this.recordStore.listIds();
  }

  /**
   * At startup, any attached invocation left non-terminal died with its
   * Conversation runtime. Mark those invocations interrupted without claiming
   * a successful outcome or delivery.
   */
  private reconcileStartup(): void {
    if (this.reconciled) return;
    this.reconciled = true;
    for (const id of this.recordStore.listIds()) {
      try {
        const record = this.recordStore.load(id);
        if (record === null) continue;
        const lastInvocation = record.invocations.at(-1);
        if (lastInvocation !== undefined && lastInvocation.status === "running") {
          this.interruptInvocation(id, lastInvocation.index);
        }
      } catch (error) {
        log.error("delegated work startup reconciliation skipped a run", {
          runId: id,
          ...boundedError(error),
        });
      }
    }
  }

  /**
   * Validate raw record JSON without reading from disk. Useful for tests and
   * migration code that need to assert the canonical shape.
   */
  static parseRecord(raw: unknown, path: string): DelegatedWorkRecord {
    return parseDelegatedWorkRecord(raw, path);
  }
}

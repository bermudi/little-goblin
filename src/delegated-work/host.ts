import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseSurfaceId } from "../surface.ts";
import { boundedError, log } from "../log.ts";
import type { ConversationId } from "../sessions/types.ts";
import {
  DelegatedWorkRecordStore,
  parseDelegatedWorkRecord,
  type DelegatedWorkKind,
  type DelegatedWorkOutcome,
  type DelegatedWorkRecord,
  type DelegatedWorkStatus,
} from "./store.ts";
import {
  asConversationRuntimeId,
  type AttachedDelegatedWorkOwnership,
  type AttachedWorkAdapter,
  type AttachedWorkRegistration,
  type ConversationRuntimeId,
  type DelegatedDeliveryState,
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
  readonly ownership: AttachedDelegatedWorkOwnership;
  readonly ready: Promise<AttachedWorkAdapter | null>;
  resolveReady: (adapter: AttachedWorkAdapter | null) => void;
  adapter: AttachedWorkAdapter | null;
  fenced: boolean;
  released: boolean;
}

function validateOwnership(ownership: AttachedDelegatedWorkOwnership): void {
  if (ownership.lifetime !== "attached") {
    throw new Error("DelegatedWorkHost only accepts attached registrations in this slice");
  }
  if (ownership.ownerConversationId.length === 0) {
    throw new Error("Attached delegated work requires an owner Conversation");
  }
  if (ownership.runtimeId.length === 0) {
    throw new Error("Attached delegated work requires a runtime identity");
  }
  if (ownership.ownershipEpochId.length === 0) {
    throw new Error("Attached delegated work requires an ownership epoch");
  }
  // SurfaceId is a branded type inside the process, but this is still a deep
  // module boundary. Validate it rather than trusting a cast from a caller.
  parseSurfaceId(ownership.originSurfaceId);
  if (ownership.executionEnvironment.kind === "project") {
    if (
      ownership.executionEnvironment.projectRoot.length === 0 ||
      !isAbsolute(ownership.executionEnvironment.projectRoot)
    ) {
      throw new Error("Attached delegated work requires an absolute project root");
    }
  } else if (ownership.executionEnvironment.kind !== "personal") {
    throw new Error("Attached delegated work has an invalid execution environment");
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
  readonly recordStore: DelegatedWorkRecordStore;
  private reconciled = false;

  constructor(home: string, recordStore?: DelegatedWorkRecordStore) {
    this.recordStore = recordStore ?? new DelegatedWorkRecordStore(home);
    this.reconcileStartup();
  }

  /** Create a runtime identity for a newly assembled Conversation runtime. */
  static newRuntimeId(): ConversationRuntimeId {
    return asConversationRuntimeId(randomUUID());
  }

  /**
   * Reserve a run before its adapter creates execution state. A runtime fence
   * therefore wins before metadata, a Pi session, or a descendant can exist.
   */
  reserveAttached(
    runId: string,
    ownership: AttachedDelegatedWorkOwnership,
  ): AttachedWorkRegistration {
    if (runId.length === 0) throw new Error("Delegated work run id must not be empty");
    validateOwnership(ownership);
    if (this.invalidatedRuntimes.has(ownership.runtimeId)) {
      throw new DelegatedWorkRuntimeInvalidatedError(ownership.runtimeId);
    }
    if (this.cancelledEpochs.has(ownership.ownershipEpochId)) {
      throw new DelegatedWorkEpochCancelledError(ownership.ownershipEpochId);
    }
    if (this.registrations.has(runId)) {
      throw new Error(`Delegated work run ${runId} is already registered`);
    }

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
        if (
          entry.fenced ||
          this.invalidatedRuntimes.has(ownership.runtimeId) ||
          this.cancelledEpochs.has(ownership.ownershipEpochId)
        ) {
          entry.fenced = true;
          adapter.fence();
          entry.resolveReady(null);
          if (this.invalidatedRuntimes.has(ownership.runtimeId)) {
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
   * that runtime. There is deliberately no timeout-success path: a failed
   * quiescence proof is returned to lifecycle orchestration as a failure.
   */
  invalidateRuntime(runtimeId: ConversationRuntimeId): Promise<void> {
    const prior = this.invalidations.get(runtimeId);
    if (prior !== undefined) return prior;

    this.invalidatedRuntimes.add(runtimeId);
    const entries = [...this.registrations.values()].filter(
      (entry) => entry.ownership.runtimeId === runtimeId,
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

  /** Exposed for diagnostics/tests without exposing adapter mechanics. */
  registeredForRuntime(runtimeId: ConversationRuntimeId): number {
    return [...this.registrations.values()].filter(
      (entry) => entry.ownership.runtimeId === runtimeId,
    ).length;
  }

  /**
   * Create a new delegated-run record with its first attached invocation.
   *
   * The returned run directory is where kind-specific state (e.g., the Pi
   * session file) must live.
   */
  createAttachedRecord(
    runId: string,
    kind: DelegatedWorkKind,
    name: string | null,
    depth: number,
    ownership: AttachedDelegatedWorkOwnership,
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

  /** Close an invocation with a terminal status, outcome, and delivery state. */
  closeInvocation(
    runId: string,
    index: number,
    status: Extract<DelegatedWorkStatus, "completed" | "cancelled" | "error" | "interrupted">,
    outcome: DelegatedWorkOutcome | null,
    deliveryState: DelegatedDeliveryState,
  ): DelegatedWorkRecord {
    return this.recordStore.closeInvocation(runId, index, status, outcome, deliveryState);
  }

  /** Update delivery state for an already-terminal invocation. */
  setDeliveryState(
    runId: string,
    index: number,
    deliveryState: DelegatedDeliveryState,
  ): DelegatedWorkRecord {
    return this.recordStore.setDeliveryState(runId, index, deliveryState);
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
          this.recordStore.closeInvocation(id, lastInvocation.index, "interrupted", null, "suppressed");
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

/**
 * Reconciliation host logic for private reflection (issue #67, decisions 0035
 * and 0038, `specs/inner-life/spec.md` "Bounded recovery before admission").
 *
 * Reconciliation is not migration (decision 0038): it runs on current-version
 * data, recovers in-flight wake state after an unclean stop, and stays
 * crash-safe because a crash is its normal input. This module owns that
 * per-boot recovery policy for inner-life wakes; production wiring (scheduler
 * triggers, boot ordering, shutdown fencing) belongs to the lifecycle unit.
 *
 * Contract:
 * - Admission gate (C3): before any recovery or new work, every persisted
 *   wake record and every canonical effect receipt must strictly validate.
 *   Corrupt, unsupported-profile, or unreadable state fails closed with the
 *   wake/effect identifier, and admission stays closed. Infrastructure
 *   failures remain failures — they propagate and never become policy
 *   rejections or quiet successes.
 * - Recovery (C1): an interrupted reflection retries its recorded immutable
 *   input under the wake's persisted three-attempt total budget. Accepted
 *   intents are replayed through their stable receipts, never regenerated.
 *   Exhausted attempts remain explicitly failed: no cursor advancement and no
 *   automatic replacement for the window. This is wake-specific budgeted
 *   recovery, not a generic retry framework.
 * - Checkpoint convergence (C2): a process stop before or after intent
 *   persistence, a SQLite commit, the wake-outcome update, or the cursor
 *   update converges on reconstruction — receipts make effect application
 *   idempotent (no duplicate adds or updates), the cursor update is monotonic
 *   (never backward), and every accepted fact is applied. Drives for one wake
 *   are serialized per host instance, so an overlapping trigger finishes the
 *   pending wake instead of bypassing it; cross-instance safety rests on the
 *   wake store's reservation identity and the receipts' stable keys.
 *
 * The host persists accepted intents into the wake record before entering
 * MemoryStore, applies each intent through the memory seam (whose canonical
 * receipt makes replays free), records the wake outcome only after all
 * durable outcomes exist, and advances the source cursor last.
 *
 * Shutdown fencing (lifecycle unit): `close()` synchronously closes wake
 * admission and aborts every active reflection; late model output can never
 * produce a memory effect. `settle()` resolves when every drive admitted
 * before close has settled, bounded by the 5-second disposal deadline. A
 * cancelled attempt consumes its persisted attempt and stays resumable;
 * drives that have not yet begun an attempt after close leave the record
 * untouched.
 */

import {
  MAX_WAKE_ATTEMPTS,
  MAX_WAKE_FAILURE_REASON_CHARS,
  WakeRecordError,
  WakeStore,
  type AcceptedIntent,
  type WakeRecord,
  type WakeReservationInput,
} from "./wake-store.ts";
import { ReflectionEngine, ReflectionError, type AcceptedFactProposal } from "./reflection.ts";
import type { ApplyFactEffectOptions } from "../memory/store.ts";
import type { MemoryEffectOutcome, MemoryFactEffect } from "../memory/policy.ts";
import { boundedError, log } from "../log.ts";
import { wakeRecordPath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The light-sleep cursor state. Shape-compatible with the existing
 * `memory-dreaming-cursor.json` files so both pipelines read the same
 * checkpoint; the file adapter is owned by the lifecycle wiring.
 */
export interface ReflectionCursorState {
  readonly processedLines: number;
  readonly lastDreamedAt: string;
}

/** Cursor persistence seam; the host owns the update policy, not the I/O. */
export interface ReflectionCursorStore {
  read(conversationId: string): ReflectionCursorState | null;
  write(conversationId: string, cursor: ReflectionCursorState): void;
}

/**
 * The memory surface the reconciliation host needs: replay-safe fact
 * application and strict canonical receipt reads for the admission gate.
 * `MemoryStore` satisfies this structurally; receipts are MemoryStore-owned
 * and this host never touches their storage.
 */
export interface ReconciliationMemoryStore {
  applyFactEffect(effect: MemoryFactEffect, opts?: ApplyFactEffectOptions): Promise<MemoryEffectOutcome>;
  readEffectReceipts(): ReadonlyArray<{ effectKey: string; payloadHash: string; outcome: MemoryEffectOutcome }>;
}

// ---------------------------------------------------------------------------
// Outcomes and errors
// ---------------------------------------------------------------------------

/** Terminal-or-resumable outcome of driving one wake. */
export type WakeReconciliationOutcome = "completed" | "failed" | "unfinished";

export interface ReconciliationReport {
  /** Wakes driven to `completed` (cursor advanced, monotonic). */
  readonly completed: readonly string[];
  /** Wakes explicitly failed (exhausted budget); their windows stay blocked. */
  readonly failed: readonly string[];
  /** Wakes still resumable (failed attempt with budget left, or cancelled). */
  readonly unfinished: readonly string[];
}

export interface WindowOutcome {
  /** The wake record after the host finished driving this window's work. */
  readonly record: WakeRecord;
  /** True when an existing reservation for the window was reused. */
  readonly coalesced: boolean;
  /**
   * True when the window did not complete: unfinished work or an explicitly
   * failed batch holds it. Callers must not advance past a blocked window and
   * must not replace its wake.
   */
  readonly blocked: boolean;
}

/** Thrown when reconciliation infrastructure fails; carries the wake identity. */
export class ReconciliationError extends Error {
  readonly wakeId: string;

  constructor(wakeId: string, detail: string, options?: { cause?: unknown }) {
    super(`wake reconciliation failed for ${wakeId}: ${detail}`, options);
    this.name = "ReconciliationError";
    this.wakeId = wakeId;
  }
}

/** Thrown when new wake work is requested before reconciliation opened admission. */
export class AdmissionClosedError extends Error {
  constructor() {
    super("inner-life admission is closed: reconciliation must complete before new wake work is admitted");
    this.name = "AdmissionClosedError";
  }
}

/**
 * Bounded shutdown disposal: `settle()` stops waiting for pre-close drives
 * after this long. Cancellation settles the reflection boundary promptly
 * (the engine rejects pre-aborted and aborted signals without adopting
 * output), so the bound is a safety cap, not the expected path.
 */
export const INNER_LIFE_DISPOSAL_DEADLINE_MS = 5_000;

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * Code-assigned model-judgment confidence for private-facts intents. The
 * extractive profile's model emits no confidence: quotation mechanically
 * proves source support, and the memory policy's confidence threshold still
 * applies at application time.
 */
export const PRIVATE_FACTS_CONFIDENCE = 0.9;

export interface ReflectionHostOptions {
  wakeStore: WakeStore;
  memory: ReconciliationMemoryStore;
  cursors: ReflectionCursorStore;
  reflection: ReflectionEngine;
  /** Clock for cursor timestamps; defaults to the system clock. */
  now?: () => Date;
}

/**
 * The deployment-owned inner-life host: reconciliation plus the reserve-and-
 * reflect path for one source window. One deep interface owns orchestration;
 * callers signal work and read outcomes.
 */
export class ReflectionHost {
  private readonly wakeStore: WakeStore;
  private readonly memory: ReconciliationMemoryStore;
  private readonly cursors: ReflectionCursorStore;
  private readonly reflection: ReflectionEngine;
  private readonly now: () => Date;
  private admitted = false;
  /** Set by close(); fences new attempts and stays closed for the process lifetime. */
  private closed = false;
  /** Per-wake drive serialization; an overlapping trigger waits, never bypasses. */
  private readonly driveLocks = new Map<string, Promise<void>>();
  /** Active drives with their settlement promises, for shutdown fencing. */
  private readonly activeDrives = new Map<AbortController, Promise<void>>();

  constructor(options: ReflectionHostOptions) {
    this.wakeStore = options.wakeStore;
    this.memory = options.memory;
    this.cursors = options.cursors;
    this.reflection = options.reflection;
    this.now = options.now ?? (() => new Date());
  }

  /** True once a full reconciliation (validation plus recovery) has succeeded. */
  get isAdmitted(): boolean {
    return this.admitted;
  }

  /** True once close() has fenced admission; never reopens. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Close wake admission synchronously and cancel every active reflection.
   * New `processWindow` calls fail immediately; in-flight drives observe the
   * abort between attempts and leave not-yet-begun attempts unburned. A
   * reflection already in flight rejects as `cancelled`: its persisted
   * attempt stays spent and the wake resumable, and no late output can
   * produce a memory effect. Idempotent; never reopens admission.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.admitted = false;
    for (const controller of this.activeDrives.keys()) {
      controller.abort();
    }
    log.info("inner-life host closed; wake admission fenced", { active: this.activeDrives.size });
  }

  /**
   * Resolve when every drive admitted before close() has settled, waiting at
   * most {@link INNER_LIFE_DISPOSAL_DEADLINE_MS}. A timeout is logged and does
   * not throw: abandoned work stays replay-safe under reconciliation.
   */
  async settle(): Promise<void> {
    if (this.activeDrives.size === 0) return;
    const drain = Promise.all([...this.activeDrives.values()]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), INNER_LIFE_DISPOSAL_DEADLINE_MS);
    });
    try {
      const result = await Promise.race([drain.then(() => "settled" as const), timeout]);
      if (result === "timeout") {
        log.error("inner-life disposal exceeded the bounded deadline; abandoned work stays replay-safe", {
          active: this.activeDrives.size,
          deadlineMs: INNER_LIFE_DISPOSAL_DEADLINE_MS,
        });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Validate every persisted record and canonical receipt, then drive every
   * interrupted wake toward a terminal or safely resumable state, then open
   * admission. Any infrastructure failure propagates and admission stays
   * closed: startup must fail before polling rather than admit on unverified
   * state.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const wakeIds = this.wakeStore.listWakeIds();
    log.info("inner-life reconciliation started", { wakes: wakeIds.length });

    // Admission gate: strict validation of all records and canonical receipts
    // before any recovery work runs (C3). WakeRecordError and the corrupt-
    // receipt error both carry the offending wake/effect identifier.
    const records: WakeRecord[] = [];
    for (const wakeId of wakeIds) {
      const record = this.wakeStore.read(wakeId);
      if (record === null) {
        throw new WakeRecordError(
          wakeId,
          wakeRecordPath(this.wakeStore.home, wakeId),
          "wake record not found",
        );
      }
      records.push(record);
    }
    this.memory.readEffectReceipts();

    const report: { completed: string[]; failed: string[]; unfinished: string[] } = {
      completed: [],
      failed: [],
      unfinished: [],
    };
    for (const record of records) {
      // Shutdown racing reconciliation: leave not-yet-driven wakes untouched
      // instead of burning attempts against a closed admission.
      if (this.closed) break;
      let outcome: WakeReconciliationOutcome;
      const controller = new AbortController();
      const drive = this.driveExclusively(record.wakeId, () => this.driveWake(record.wakeId, controller.signal));
      this.activeDrives.set(controller, drive.then(() => undefined, () => undefined));
      try {
        outcome = await drive;
      } catch (err) {
        log.error("inner-life reconciliation failed; admission stays closed", {
          wakeId: record.wakeId,
          ...boundedError(err),
        });
        throw err instanceof ReconciliationError
          ? err
          : new ReconciliationError(record.wakeId, boundedError(err).error, { cause: err });
      } finally {
        this.activeDrives.delete(controller);
      }
      report[outcome].push(record.wakeId);
    }
    if (this.closed) {
      log.warn("inner-life reconciliation interrupted by shutdown; admission stays closed", {
        wakes: wakeIds.length,
        completed: report.completed.length,
        failed: report.failed.length,
        unfinished: report.unfinished.length,
      });
      return report;
    }
    this.admitted = true;
    log.info("inner-life reconciliation completed; admission open", {
      wakes: wakeIds.length,
      completed: report.completed.length,
      failed: report.failed.length,
      unfinished: report.unfinished.length,
    });
    return report;
  }

  /**
   * Admit one light-sleep batch for a source window and drive it to a
   * terminal or safely resumable state. Overlapping triggers for the same
   * window coalesce onto the existing wake (the wake store rejects conflicting
   * input); a pending or failed wake holds the window — the trigger finishes
   * or observes the block instead of replacing it.
   */
  async processWindow(input: WakeReservationInput, signal?: AbortSignal): Promise<WindowOutcome> {
    if (!this.admitted) throw new AdmissionClosedError();
    // The drive controller is created, wired, and registered synchronously
    // with the admission check, so a concurrent close() either observes this
    // drive (and aborts it) or the admission check has already failed.
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const body = this.processWindowBody(input, controller.signal);
    this.activeDrives.set(controller, body.then(() => undefined, () => undefined));
    try {
      return await body;
    } finally {
      this.activeDrives.delete(controller);
      if (signal !== undefined) signal.removeEventListener("abort", forwardAbort);
    }
  }

  private async processWindowBody(input: WakeReservationInput, signal: AbortSignal): Promise<WindowOutcome> {
    const reservation = await this.wakeStore.reserve(input);
    const wakeId = reservation.record.wakeId;
    await this.driveExclusively(wakeId, () => this.driveWake(wakeId, signal));
    const record = this.wakeStore.read(wakeId);
    if (record === null) {
      throw new WakeRecordError(
        wakeId,
        wakeRecordPath(this.wakeStore.home, wakeId),
        "wake record missing after driving",
      );
    }
    return { record, coalesced: reservation.coalesced, blocked: record.state !== "completed" };
  }

  // -------------------------------------------------------------------------

  /**
   * Serialize drives per wake so overlapping triggers converge on the same
   * durable state instead of racing transitions.
   */
  private driveExclusively<T>(wakeId: string, drive: () => Promise<T>): Promise<T> {
    const tail = (this.driveLocks.get(wakeId) ?? Promise.resolve()).catch(() => {});
    const result = tail.then(drive);
    const settled: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.driveLocks.set(wakeId, settled);
    void settled.then(() => {
      // Only the last drive for this wake clears the entry; a queued drive
      // has already replaced it.
      if (this.driveLocks.get(wakeId) === settled) this.driveLocks.delete(wakeId);
    });
    return result;
  }

  /**
   * Drive one wake toward a terminal or safely resumable state. Each pass
   * consumes at most one persisted reflection attempt; effect application and
   * cursor advancement are replay-safe, so repeated passes converge.
   */
  private async driveWake(wakeId: string, signal?: AbortSignal): Promise<WakeReconciliationOutcome> {
    for (;;) {
      const record = this.readWake(wakeId);
      switch (record.state) {
        case "completed":
          this.advanceCursor(record);
          return "completed";
        case "failed":
          return "failed";
        case "applying":
          // Accepted intents are already durable: apply them from the record.
          await this.applyRecordedIntents(record);
          continue;
        case "reserved":
        case "reflecting": {
          // Post-close drives never begin another attempt: the record is left
          // exactly as it stands for a later boot's reconciliation.
          if (this.closed) return "unfinished";
          const attempt = await this.runAttempt(record, signal);
          if (attempt === "failed") return "failed";
          if (attempt === "unfinished") return "unfinished";
          continue;
        }
      }
    }
  }

  /**
   * Run at most one reflection attempt from the recorded immutable input.
   * The attempt is persisted before the model invocation; a failed attempt
   * with budget remaining leaves the wake resumable (a later reconciliation
   * pass retries), the last permitted failure marks the batch explicitly
   * failed, and host cancellation leaves it resumable regardless.
   */
  private async runAttempt(
    record: WakeRecord,
    signal?: AbortSignal,
  ): Promise<"applied" | "failed" | "unfinished"> {
    if (record.attempts >= MAX_WAKE_ATTEMPTS) {
      const reason = `attempt budget exhausted after ${record.attempts} attempts; the batch stays failed`;
      log.warn("wake attempt budget exhausted", { wakeId: record.wakeId, attempts: record.attempts });
      this.failWake(record.wakeId, reason);
      return "failed";
    }
    const begun = this.wakeStore.applyTransition(record.wakeId, { kind: "begin-attempt" });
    let proposals: readonly AcceptedFactProposal[];
    let rejections: readonly { itemIndex: number; reason: string }[];
    try {
      const outcome = await this.reflection.reflect({
        wakeId: begun.wakeId,
        profile: begun.profile,
        lines: begun.input.lines,
        signal,
      });
      proposals = outcome.proposals;
      rejections = outcome.rejections;
    } catch (err) {
      if (err instanceof ReflectionError && err.kind === "cancelled") {
        log.warn("reflection cancelled; wake stays resumable", {
          wakeId: begun.wakeId,
          attempts: begun.attempts,
        });
        return "unfinished";
      }
      const spent = begun.attempts;
      if (spent >= MAX_WAKE_ATTEMPTS) {
        log.error("reflection failed on the final permitted attempt; the batch stays failed", {
          wakeId: begun.wakeId,
          attempts: spent,
          ...boundedError(err),
        });
        this.failWake(begun.wakeId, boundedFailureReason(err));
        return "failed";
      }
      log.warn("reflection attempt failed; the wake stays resumable within the attempt budget", {
        wakeId: begun.wakeId,
        attempts: spent,
        ...boundedError(err),
      });
      return "unfinished";
    }
    for (const rejection of rejections) {
      log.debug("reflection item rejected", {
        wakeId: begun.wakeId,
        itemIndex: rejection.itemIndex,
        reason: rejection.reason,
      });
    }
    if (rejections.length > 0) {
      log.info("reflection recorded item rejections", { wakeId: begun.wakeId, rejected: rejections.length });
    }
    // Persist the accepted intents BEFORE any memory mutation (decision 0035).
    const applying = this.wakeStore.applyTransition(begun.wakeId, {
      kind: "begin-application",
      intents: toIntents(begun.wakeId, proposals),
    });
    await this.applyRecordedIntents(applying);
    return "applied";
  }

  /**
   * Apply every accepted intent in the record through MemoryStore and only
   * then record the wake outcome and advance the cursor. Re-application is
   * free: each intent's stable key replays its committed receipt, so no add
   * or update ever happens twice and no accepted fact is skipped.
   */
  private async applyRecordedIntents(record: WakeRecord): Promise<void> {
    for (const intent of record.acceptedIntents) {
      const outcome = await this.memory.applyFactEffect(this.intentEffect(record, intent));
      log.debug("memory effect outcome", {
        wakeId: record.wakeId,
        effectKey: intent.effectKey,
        kind: outcome.kind,
      });
    }
    // Wake-outcome update only after all durable outcomes exist...
    const completed = this.wakeStore.applyTransition(record.wakeId, { kind: "complete" });
    // ...and the cursor update comes last, monotonic against any checkpoint.
    this.advanceCursor(completed);
  }

  private intentEffect(record: WakeRecord, intent: AcceptedIntent): MemoryFactEffect {
    const cited = record.input.lines.find((candidate) => candidate.index === intent.lineIndex);
    if (cited === undefined) {
      throw new ReconciliationError(
        record.wakeId,
        `accepted intent ${intent.effectKey} cites line ${intent.lineIndex} outside the captured input`,
      );
    }
    return {
      effectKey: intent.effectKey,
      target: intent.target,
      text: intent.text,
      confidence: intent.confidence,
      source: {
        session: record.source.conversationId,
        lineIndex: intent.lineIndex,
        sourceSurfaceId: cited.sourceSurfaceId ?? null,
      },
    };
  }

  /**
   * Advance the source cursor to the wake's window end — never backward, and
   * never for a wake that did not complete. Replays past an existing
   * checkpoint are no-ops.
   */
  private advanceCursor(record: WakeRecord): void {
    const conversationId = record.source.conversationId;
    const current = this.cursors.read(conversationId);
    if (current !== null && current.processedLines >= record.source.beforeLine) return;
    const cursor: ReflectionCursorState = {
      processedLines: record.source.beforeLine,
      lastDreamedAt: this.now().toISOString(),
    };
    this.cursors.write(conversationId, cursor);
    log.info("light-sleep cursor advanced", {
      wakeId: record.wakeId,
      conversationId,
      processedLines: cursor.processedLines,
    });
  }

  private failWake(wakeId: string, reason: string): void {
    this.wakeStore.applyTransition(wakeId, {
      kind: "fail",
      reason: reason.slice(0, MAX_WAKE_FAILURE_REASON_CHARS),
    });
  }

  private readWake(wakeId: string): WakeRecord {
    const record = this.wakeStore.read(wakeId);
    if (record === null) {
      throw new WakeRecordError(
        wakeId,
        wakeRecordPath(this.wakeStore.home, wakeId),
        "wake record not found",
      );
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the persisted accepted intents from validated proposals. Effect keys
 * are derived from the wake id, so the canonical receipt key is stable across
 * recovery regardless of which host persists the intents.
 */
function toIntents(wakeId: string, proposals: readonly AcceptedFactProposal[]): AcceptedIntent[] {
  return proposals.map((proposal, position) => ({
    effectKey: `${wakeId}:effect:${position}`,
    kind: "fact",
    target: proposal.target,
    lineIndex: proposal.lineIndex,
    text: proposal.text,
    confidence: PRIVATE_FACTS_CONFIDENCE,
  }));
}

/** Bounded, identity-bearing failure reason for the wake record. */
function boundedFailureReason(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return detail.slice(0, MAX_WAKE_FAILURE_REASON_CHARS);
}

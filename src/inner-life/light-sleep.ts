/**
 * Light-sleep lifecycle wiring for private reflection (issue #67, decision
 * 0035, `specs/inner-life/spec.md` "Existing scheduling, separate execution").
 *
 * This module is the deployment-owned composition of the inner-life host:
 * it owns the light-sleep backlog policy (fresh-cursor seeding, finite
 * snapshots, bounded batch draining, lookback filtering, expired-line
 * warnings and metrics, per-Conversation serialization) and the production
 * cursor adapter, and it signals every extracted batch to the one
 * `ReflectionHost`. Callers — the scheduler timer, startup, shutdown — only
 * signal work and lifecycle:
 *
 * - `reconcile()` must complete before memory timers and Telegram polling
 *   are admitted (the pass refuses to run while admission is closed, so a
 *   mis-ordered timer cannot create wakes).
 * - `lightSleep.runPass()` is the single work signal the scheduler holds.
 * - `close()` synchronously fences admission and cancels active reflection;
 *   `settle()` bounds disposal; `dispose()` releases the memory connection.
 *
 * The dreaming internal conversation runtime is no longer part of this path:
 * nothing here constructs a Surface, Conversation, internal session, or
 * Telegram destination, and no tool ever executes. REM and deep sleep keep
 * their existing DreamingPipeline scheduling; light sleep coordinates with
 * them through the pipeline's global phase queue via the `phases` seam.
 */

import { existsSync, readFileSync } from "node:fs";
import { log } from "../log.ts";
import { atomicWrite } from "../fs.ts";
import { memoryDreamingCursorPath } from "../sessions/paths.ts";
import { countTranscriptLines, readTranscriptAfter, type TranscriptLine } from "../sessions/transcript.ts";
import type { Config } from "../config.ts";
import type { MemoryStore } from "../memory/store.ts";
import { LOOKBACK_HOURS, MAX_MODEL_LINES } from "../memory/dreaming.ts";
import type { ReflectionModelInvoker } from "./reflection.ts";
import { ReflectionEngine } from "./reflection.ts";
import { PRIVATE_FACTS_PROFILE, WakeStore, type WakeInputLine, type WakeReservationInput } from "./wake-store.ts";
import {
  ReflectionHost,
  type ReflectionCursorState,
  type ReflectionCursorStore,
  type ReconciliationReport,
} from "./recovery.ts";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Global dreaming-phase queue seam (satisfied by `DreamingPipeline`). */
export interface DreamingPhaseQueue {
  runExclusivePhase<T>(fn: () => Promise<T>): Promise<T>;
}

/** Canonical Conversation catalog seam (satisfied by `ConversationStore`). */
export interface LightSleepConversations {
  list(): ReadonlyArray<{ id: string }>;
}

/** Transcript reading seam (defaults to the shared transcript module). */
export interface LightSleepTranscripts {
  countLines(home: string, conversationId: string): number;
  readAfter(home: string, conversationId: string, processedLines: number): TranscriptLine[];
}

/** Narrow metrics seam (satisfied by `MetricsStore`). */
export interface LightSleepMetrics {
  incrementCounter(name: string, scope: string | null, delta?: number): void;
}

const defaultTranscripts: LightSleepTranscripts = {
  countLines: (home, conversationId) => countTranscriptLines(home, conversationId),
  readAfter: (home, conversationId, processedLines) =>
    readTranscriptAfter(home, conversationId, processedLines),
};

// ---------------------------------------------------------------------------
// Production cursor adapter
// ---------------------------------------------------------------------------

/**
 * File-backed light-sleep cursor adapter: the production realization of the
 * host's `ReflectionCursorStore` seam, honoring the retained light-sleep
 * cursor policy. The checkpoint stays the existing
 * `memory-dreaming-cursor.json` sidecar owned by the light-sleep pipeline, so
 * existing cursor values are preserved (never reset to re-extract history)
 * and the host's wake-completion checkpoints and this adapter's seeding
 * checkpoints land in the same files. Writes are mode-preserving atomic
 * replacements; absence (ENOENT) and malformed content read as absent.
 */
export class FileReflectionCursorStore implements ReflectionCursorStore {
  constructor(readonly home: string) {}

  read(conversationId: string): ReflectionCursorState | null {
    const path = memoryDreamingCursorPath(this.home, conversationId);
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ReflectionCursorState>;
      if (typeof parsed.processedLines === "number" && typeof parsed.lastDreamedAt === "string") {
        return { processedLines: parsed.processedLines, lastDreamedAt: parsed.lastDreamedAt };
      }
    } catch {
      // A malformed sidecar behaves as absent; the pass then seeds a fresh
      // cursor at the current transcript end, so no history is re-extracted.
    }
    return null;
  }

  write(conversationId: string, cursor: ReflectionCursorState): void {
    atomicWrite(memoryDreamingCursorPath(this.home, conversationId), JSON.stringify(cursor));
  }
}

// ---------------------------------------------------------------------------
// Light-sleep pass
// ---------------------------------------------------------------------------

export interface LightSleepPassOptions {
  home: string;
  host: ReflectionHost;
  /** Checkpoint seam; the composition wires one store into host and pass. */
  cursors: ReflectionCursorStore;
  conversations: LightSleepConversations;
  /** REM/deep coordination; the composition wires the DreamingPipeline. */
  phases?: DreamingPhaseQueue;
  transcripts?: LightSleepTranscripts;
  metrics?: LightSleepMetrics;
  /** Lookback window in hours; 0 disables expiry filtering. */
  lookbackHours?: number;
  /** Maximum captured transcript lines per wake (the configured batch limit). */
  batchLimitLines?: number;
  now?: () => Date;
  /**
   * Invoked after the per-Conversation error log. The scheduler keeps
   * draining remaining conversations (existing light-sleep semantics); this
   * seam makes the failures observable to tests and callers.
   */
  onConversationError?: (conversationId: string, err: unknown) => void;
}

/**
 * The light-sleep backlog policy, ending in one host signal per extracted
 * batch. One pass enumerates the canonical Conversation catalog and drains
 * each conversation's unread backlog in finite batches; overlapping passes
 * coalesce per Conversation.
 */
export class LightSleepPass {
  private readonly home: string;
  private readonly host: ReflectionHost;
  private readonly cursors: ReflectionCursorStore;
  private readonly conversations: LightSleepConversations;
  private readonly phases: DreamingPhaseQueue | undefined;
  private readonly transcripts: LightSleepTranscripts;
  private readonly metrics: LightSleepMetrics | undefined;
  private readonly lookbackHours: number;
  private readonly batchLimitLines: number;
  private readonly now: () => Date;
  private readonly onConversationError: ((conversationId: string, err: unknown) => void) | undefined;
  /** Per-Conversation coalescing: an overlapping pass waits, never re-drives. */
  private readonly sessions = new Map<string, { running: Promise<void> | null; pending: boolean }>();

  constructor(options: LightSleepPassOptions) {
    this.home = options.home;
    this.host = options.host;
    this.cursors = options.cursors;
    this.conversations = options.conversations;
    this.phases = options.phases;
    this.transcripts = options.transcripts ?? defaultTranscripts;
    this.metrics = options.metrics;
    this.lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS;
    this.batchLimitLines = options.batchLimitLines ?? MAX_MODEL_LINES;
    this.now = options.now ?? (() => new Date());
    this.onConversationError = options.onConversationError;
  }

  /**
   * Run one light-sleep pass over the whole catalog. Per-Conversation
   * failures are logged and surfaced through `onConversationError` without
   * blocking the remaining conversations. Skipped entirely while inner-life
   * admission is closed (before reconciliation, or after shutdown close).
   */
  async runPass(): Promise<void> {
    if (!this.host.isAdmitted) {
      log.debug("light-sleep pass skipped: inner-life admission is closed");
      return;
    }
    for (const conversation of this.conversations.list()) {
      if (!this.host.isAdmitted) {
        log.info("light-sleep pass stopped: inner-life admission is closed", {
          conversationId: conversation.id,
        });
        return;
      }
      await this.runConversationCoalesced(conversation.id);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Coalesce overlapping work per Conversation: a pass arriving while a
   * conversation is mid-drain marks it pending and lets the running drain
   * rerun once, mirroring the existing light-sleep semantics.
   */
  private async runConversationCoalesced(conversationId: string): Promise<void> {
    let state = this.sessions.get(conversationId);
    if (state === undefined) {
      state = { running: null, pending: false };
      this.sessions.set(conversationId, state);
    }
    if (state.running !== null) {
      state.pending = true;
      return;
    }
    state.pending = false;
    const run = this.processConversationSafe(conversationId).finally(() => {
      const s = this.sessions.get(conversationId);
      if (s === undefined) return;
      s.running = null;
      if (s.pending) {
        s.pending = false;
        void this.runConversationCoalesced(conversationId);
      } else {
        this.sessions.delete(conversationId);
      }
    });
    state.running = run;
    await run;
  }

  private async processConversationSafe(conversationId: string): Promise<void> {
    const work = (): Promise<void> => this.processConversation(conversationId);
    try {
      if (this.phases !== undefined) {
        await this.phases.runExclusivePhase(work);
      } else {
        await work();
      }
    } catch (err) {
      log.warn("scheduled light sleep failed for conversation", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.onConversationError?.(conversationId, err);
    }
  }

  /**
   * Drain one conversation's unread backlog. Mirrors the retained light-sleep
   * policy: a fresh cursor seeds at the current transcript end (existing
   * history is never re-extracted), the snapshot is read once and drained in
   * configured line batches, lines outside the lookback window are warned and
   * counted but never reflected, and a blocked window holds the conversation
   * for a later pass.
   */
  private async processConversation(conversationId: string): Promise<void> {
    const cursor = this.cursors.read(conversationId);
    if (cursor === null) {
      const total = this.transcripts.countLines(this.home, conversationId);
      this.writeCursorForward(conversationId, total);
      log.debug("light-sleep cursor seeded", { conversationId, processedLines: total });
      return;
    }

    const snapshot = this.transcripts.readAfter(this.home, conversationId, cursor.processedLines);
    const cutoff = this.lookbackHours > 0 ? this.now().getTime() - this.lookbackHours * 60 * 60 * 1000 : null;
    let offset = 0;
    let windowStart = cursor.processedLines;

    while (offset < snapshot.length) {
      const batch: TranscriptLine[] = [];
      let skippedExpired = 0;
      while (offset < snapshot.length && batch.length < this.batchLimitLines) {
        const line = snapshot[offset++]!;
        if (cutoff !== null && !(new Date(line.ts).getTime() >= cutoff)) {
          skippedExpired++;
        } else {
          batch.push(line);
        }
      }
      const batchEnd = snapshot[offset - 1]!.index + 1;

      if (skippedExpired > 0) {
        log.warn("light-sleep skipped transcript lines outside lookback window", {
          conversationId,
          count: skippedExpired,
          lookbackHours: this.lookbackHours,
        });
        this.metrics?.incrementCounter("memory_dreaming_expired_lines_total", null, skippedExpired);
      }

      if (batch.length === 0) {
        // Nothing extractable in this span; checkpoint past it without a wake.
        this.writeCursorForward(conversationId, batchEnd);
        break;
      }

      const input: WakeReservationInput = {
        conversationId,
        afterLine: windowStart,
        beforeLine: batchEnd,
        profile: PRIVATE_FACTS_PROFILE,
        lines: batch.map((line): WakeInputLine => {
          const wakeLine: WakeInputLine = {
            index: line.index,
            role: line.role,
            text: line.text,
            ts: line.ts,
          };
          if (line.sourceSurfaceId !== undefined) wakeLine.sourceSurfaceId = line.sourceSurfaceId;
          return wakeLine;
        }),
      };
      const outcome = await this.host.processWindow(input);
      if (outcome.blocked) {
        // A failed or unfinished wake holds its window: never advance past a
        // blocked batch, and never replace its wake. A later pass observes
        // the block (or finishes resumable work) instead.
        log.warn("light-sleep window blocked; the conversation waits for a later pass", {
          conversationId,
          wakeId: outcome.record.wakeId,
          state: outcome.record.state,
        });
        return;
      }
      windowStart = batchEnd;
    }
  }

  /**
   * Checkpoint forward only: never move a light-sleep cursor backward.
   * Write failures propagate — progress is never silently advanced, and a
   * blocked checkpoint is retried by a later pass against the durable wake.
   */
  private writeCursorForward(conversationId: string, processedLines: number): void {
    const current = this.cursors.read(conversationId);
    if (current !== null && current.processedLines >= processedLines) return;
    this.cursors.write(conversationId, {
      processedLines,
      lastDreamedAt: this.now().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Deployment composition
// ---------------------------------------------------------------------------

export interface InnerLifeLifecycleOptions {
  home: string;
  /** Dedicated memory connection for fact effects; `dispose()` closes it. */
  memory: MemoryStore;
  conversations: LightSleepConversations;
  /** The deployment's existing model selection. Mutually exclusive with `model`. */
  config?: Config;
  /** Deterministic invoker seam for verification. Mutually exclusive with `config`. */
  model?: { invoker: ReflectionModelInvoker; deadlineMs?: number };
  /** REM/deep coordination queue; the composition wires the DreamingPipeline. */
  phases?: DreamingPhaseQueue;
  /** Transcript reading seam override; defaults to the shared transcript module. */
  transcripts?: LightSleepTranscripts;
  metrics?: LightSleepMetrics;
  lookbackHours?: number;
  batchLimitLines?: number;
  now?: () => Date;
  onConversationError?: (conversationId: string, err: unknown) => void;
}

export interface InnerLifeLifecycle {
  /**
   * Validate every persisted wake record and canonical receipt and recover
   * interrupted work; must complete before memory timers and Telegram
   * polling are admitted. A failure fails startup closed.
   */
  reconcile(): Promise<ReconciliationReport>;
  /** The deployment's one host instance. */
  readonly host: ReflectionHost;
  /** The single work signal the scheduler holds for light sleep. */
  readonly lightSleep: { runPass(): Promise<void> };
  /** Synchronously fence admission and cancel active reflection. */
  close(): void;
  /** Wait (bounded) for pre-close drives to settle. */
  settle(): Promise<void>;
  /** Release the memory connection. Idempotent. */
  dispose(): void;
}

/**
 * Compose the deployment-owned inner-life host: exactly one host, wake
 * store, reflection engine, cursor adapter, and light-sleep pass. The wake
 * store's line cap and the pass's batch limit derive from the same
 * configured value so a batch can never exceed its record bound.
 */
export function createInnerLifeLifecycle(options: InnerLifeLifecycleOptions): InnerLifeLifecycle {
  if ((options.config !== undefined) === (options.model !== undefined)) {
    throw new Error("createInnerLifeLifecycle requires exactly one of config or model");
  }
  const batchLimitLines = options.batchLimitLines ?? MAX_MODEL_LINES;
  const reflection: ReflectionEngine =
    options.model !== undefined
      ? new ReflectionEngine({ invoker: options.model.invoker, deadlineMs: options.model.deadlineMs })
      : new ReflectionEngine({ config: options.config as Config });

  const wakeStore = new WakeStore(options.home, { maxInputLines: batchLimitLines });
  const cursors = new FileReflectionCursorStore(options.home);
  const host = new ReflectionHost({
    wakeStore,
    memory: options.memory,
    cursors,
    reflection,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const pass = new LightSleepPass({
    home: options.home,
    host,
    cursors,
    conversations: options.conversations,
    ...(options.phases !== undefined ? { phases: options.phases } : {}),
    ...(options.transcripts !== undefined ? { transcripts: options.transcripts } : {}),
    ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
    ...(options.lookbackHours !== undefined ? { lookbackHours: options.lookbackHours } : {}),
    batchLimitLines,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onConversationError !== undefined
      ? { onConversationError: options.onConversationError }
      : {}),
  });

  let disposed = false;
  return {
    host,
    lightSleep: { runPass: () => pass.runPass() },
    reconcile: () => host.reconcile(),
    close: () => host.close(),
    settle: () => host.settle(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      options.memory.close();
    },
  };
}

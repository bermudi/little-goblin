import { readFileSync } from "node:fs";
import { log } from "../log.ts";
import { heartbeatMdPath } from "../workspace/paths.ts";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import type { ConversationState } from "../sessions/mod.ts";
import { surfaceId, type Surface } from "../surface.ts";

import type { MemoryEngine } from "../memory/engine.ts";
import { DREAMING_CATEGORIES, type DreamingCategory } from "../memory/dreaming.ts";
import type { Candidate, CandidateExtractor } from "../memory/dreaming.ts";
import { appendQuarantine } from "../memory/quarantine.ts";
import type { TranscriptLine } from "../sessions/transcript.ts";
import type { ScheduledTurn } from "./types.ts";
import type { ScheduleStore } from "./store.ts";
import type { InternalSessionId, InternalSessionState } from "../sessions/internal-session.ts";
import type { ScheduledTurnAdmission } from "../orchestration/dispatcher.ts";

/**
 * Default scheduler tick interval: 60 seconds. Bounds worst-case delivery
 * latency to ~60s, well inside the granularity users care about for a personal
 * assistant. Not configurable in v1 (see design decision "Scheduler ticks
 * every 60 seconds"). Exposed as a named constant so tests and future config
 * can reference it.
 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
export const DEFAULT_TRANSCRIPT_SYNC_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_TRANSCRIPT_SYNC_INTERVAL", 5);
export const DEFAULT_TRANSCRIPT_SYNC_MAX_MS = 30_000;
export const DEFAULT_DREAMING_LIGHT_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL", 4 * 60);
export const DEFAULT_DREAMING_REM_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_DREAM_REM_INTERVAL", 24 * 60);
export const DEFAULT_DREAMING_DEEP_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_DREAM_DEEP_INTERVAL", 24 * 60);

const DEFAULT_REM_LOCAL_TIME = parseLocalTime("GOBLIN_MEMORY_DREAM_REM_LOCAL_TIME", "03:00");
const DEFAULT_DEEP_LOCAL_TIME = parseLocalTime("GOBLIN_MEMORY_DREAM_DEEP_LOCAL_TIME", "04:00");

function parseIntervalMinutes(key: string, fallbackMinutes: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallbackMinutes * 60_000;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "0") return Number.POSITIVE_INFINITY;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : fallbackMinutes * 60_000;
}

function parseLocalTime(key: string, fallback: string): { hour: number; minute: number } {
  const raw = process.env[key] ?? fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (m) {
    const hour = Number.parseInt(m[1] as string, 10);
    const minute = Number.parseInt(m[2] as string, 10);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return { hour, minute };
    }
  }
  const [fh, fm] = fallback.split(":").map((s) => Number.parseInt(s, 10));
  return { hour: fh ?? 0, minute: fm ?? 0 };
}

/**
 * The system-owned heartbeat prompt. The `[heartbeat]` prefix makes the prompt
 * distinguishable from user-authored text at the agent layer and in
 * transcripts. The body MUST NOT claim a user asked a new question.
 *
 * Pinned here (not constructed dynamically) so drift cannot quietly violate
 * the "MUST NOT claim a user asked a new question" rule.
 */
export const HEARTBEAT_PROMPT =
  "[heartbeat] This is a scheduled self-check-in. No user message prompted this turn. Review the current conversation context and decide whether there is anything useful, timely, or important to say. If there is nothing worth saying, reply briefly that you have nothing to add and stop.";

/**
 * Read a candidate heartbeat prompt file and return its content if it exists
 * and is non-whitespace. Returns `null` for ENOENT or whitespace-only files.
 * Non-ENOENT read errors propagate.
 */
function readCandidate(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (raw.trim().length === 0) return null;
  return raw.trimEnd();
}

/**
 * Resolve the heartbeat prompt body for a given Surface.
 *
 * Checks candidates in first-non-empty-wins order:
 * 1. `$GOBLIN_HOME/state/surfaces/<SurfaceId>/HEARTBEAT.md`
 * 2. `$GOBLIN_HOME/workspace/HEARTBEAT.md`
 * 3. The system-owned `HEARTBEAT_PROMPT` constant
 *
 * When a file yields non-whitespace content, its content is used as the prompt
 * body with the `[heartbeat] ` prefix prepended (the file holds the user-
 * authored body; the system owns the prefix). When a file is absent or
 * empty/whitespace-only, the next candidate is tried. The constant already
 * includes the `[heartbeat]` prefix, so no double-prefixing occurs on the
 * fallback path. Non-ENOENT read errors propagate (fail loud, per AGENTS.md).
 *
 * Whitespace contract: leading whitespace is preserved (the user may intend it
 * as part of the body, e.g. an indented first line); only trailing whitespace
 * is stripped. The emptiness check uses `trim()` so a file of only whitespace
 * falls back to the next candidate.
 */
function stripLeadingHeartbeat(body: string): string {
  return body.replace(/^\[heartbeat\]\s*/, "");
}

export function resolveHeartbeatPrompt(home: string, surface: Surface): string {
  const surfaceBody = readCandidate(surfaceHeartbeatPath(home, surfaceId(surface)));
  if (surfaceBody !== null) return `[heartbeat] ${stripLeadingHeartbeat(surfaceBody)}`;
  const globalBody = readCandidate(heartbeatMdPath(home));
  if (globalBody !== null) return `[heartbeat] ${stripLeadingHeartbeat(globalBody)}`;
  return HEARTBEAT_PROMPT;
}

/**
 * Clock and timer injection for tests. The default uses the real wall clock
 * and `setTimeout`; tests pass fakes to drive ticks deterministically without
 * waiting.
 */
export interface SchedulerClock {
  now(): number;
  setInterval(fn: () => void, ms: number): { clear(): void };
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    return { clear: () => clearInterval(handle) };
  },
};

/**
 * A sink the loop dispatches due prompts through. In production this is the
 * shared `TurnDispatcher`; tests pass a fake that records calls. Mirrors the
 * slice of `TurnDispatcher` the loop needs.
 */
export interface SchedulerDispatcher {
  /**
   * True when the runtime kernel is still accepting work. The scheduler reads
   * this before claiming a due occurrence so a shutdown in flight cannot
   * permanently consume a one-shot schedule as though it ran.
   */
  runtimeAdmissionOpen(): boolean;
  enqueueScheduledTurn(
    conversation: ConversationState,
    surface: Surface,
    content: string,
    onError?: (err: unknown) => void,
  ): boolean | ScheduledTurnAdmission;
  enqueueInternalTurn?(
    internalSession: InternalSessionState,
    content: string,
    onComplete: (text: string) => void,
    onError: (err: unknown) => void,
  ): void;
}

/** Scheduler-facing slice of ConversationLifecycle for late binding. */
export interface SchedulerConversationLifecycle {
  resolveCurrent(surface: Surface): Promise<ConversationState | null>;
}

/** Catalog of every non-archived canonical Conversation. */
export interface ConversationCatalog {
  list(): ConversationState[];
}

/** Persistence seam for the Surface-free dreaming compatibility runtime. */
export interface SchedulerInternalSessionStore {
  ensure(id: InternalSessionId): InternalSessionState;
}

export interface SchedulerOptions {
  store: ScheduleStore;
  lifecycle: SchedulerConversationLifecycle;
  conversationCatalog: ConversationCatalog;
  internalSessionStore: SchedulerInternalSessionStore;
  dispatcher: SchedulerDispatcher;
  /** `$GOBLIN_HOME`, used to resolve the heartbeat prompt file at dispatch time. */
  home: string;
  clock?: SchedulerClock;
  tickIntervalMs?: number;
  /** Optional memory engine; when present the loop schedules transcript sync and dreaming phases. */
  memoryEngine?: MemoryEngine;
  /** Interval in ms between transcript sync ticks. Default 5 minutes. */
  transcriptSyncIntervalMs?: number;
  /** Interval in ms between dreaming light-sleep passes. Default 4 hours. */
  dreamingLightIntervalMs?: number;
  /** Interval in ms between REM-sleep phases. Default 24 hours. */
  dreamingRemIntervalMs?: number;
  /** Interval in ms between deep-sleep phases. Default 24 hours. */
  dreamingDeepIntervalMs?: number;
}

/**
 * Single-process scheduler loop. Polls the schedule store for due enabled
 * schedules, claims each due schedule one at a time within a tick, resolves the
 * Surface's current Conversation through ConversationLifecycle, and dispatches
 * valid prompts through the shared turn dispatcher.
 *
 * Lifecycle:
 *   - `start()` begins only after startup reconciliation (caller's ordering).
 *   - `stop()` clears the timer; in-flight ticks may finish but no new due
 *     schedules are dispatched after stop begins.
 *   - Tick errors are logged and swallowed so future ticks continue.
 */
export class SchedulerLoop {
  private readonly store: ScheduleStore;
  private readonly lifecycle: SchedulerConversationLifecycle;
  private readonly conversationCatalog: ConversationCatalog;
  private readonly internalSessionStore: SchedulerInternalSessionStore;
  private readonly dispatcher: SchedulerDispatcher;
  private readonly clock: SchedulerClock;
  private readonly tickIntervalMs: number;
  private readonly home: string;
  private readonly memoryEngine?: MemoryEngine;
  private readonly transcriptSyncIntervalMs: number;
  private readonly dreamingLightIntervalMs: number;
  private readonly dreamingRemIntervalMs: number;
  private readonly dreamingDeepIntervalMs: number;
  private timer: { clear(): void } | null = null;
  private memoryTimers: { clear(): void }[] = [];
  private ticking = false;
  /** Every timer-originated operation remains here until it settles. */
  private readonly activeJobs = new Set<Promise<void>>();
  private stopDrainPromise: Promise<void> | undefined;
  private memorySchedulingOpen = false;
  /** Scheduler-owned claim fence. Unlike timer state, this remains closed even
   * when stop() races a tick that is already awaiting binding resolution. */
  private claimsOpen = true;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.lifecycle = options.lifecycle;
    this.conversationCatalog = options.conversationCatalog;
    this.internalSessionStore = options.internalSessionStore;
    this.dispatcher = options.dispatcher;
    this.clock = options.clock ?? realClock;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.home = options.home;
    this.memoryEngine = options.memoryEngine;
    this.transcriptSyncIntervalMs = options.transcriptSyncIntervalMs ?? DEFAULT_TRANSCRIPT_SYNC_INTERVAL_MS;
    this.dreamingLightIntervalMs = options.dreamingLightIntervalMs ?? DEFAULT_DREAMING_LIGHT_INTERVAL_MS;
    this.dreamingRemIntervalMs = options.dreamingRemIntervalMs ?? DEFAULT_DREAMING_REM_INTERVAL_MS;
    this.dreamingDeepIntervalMs = options.dreamingDeepIntervalMs ?? DEFAULT_DREAMING_DEEP_INTERVAL_MS;
  }

  /** Begin ticking. No-op if already started. */
  start(): void {
    if (this.timer) return;
    this.claimsOpen = true;
    this.memorySchedulingOpen = true;
    this.timer = this.clock.setInterval(() => {
      this.trackJob(this.tick());
    }, this.tickIntervalMs);
    this.startMemoryTimers();
    log.info("scheduler started", { tickIntervalMs: this.tickIntervalMs });
  }

  /** Stop ticking. No-op if not started. Safe to call during shutdown. */
  stop(): void {
    this.claimsOpen = false;
    this.memorySchedulingOpen = false;
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }
    for (const t of this.memoryTimers) {
      t.clear();
    }
    this.memoryTimers = [];
    log.info("scheduler stopped");
  }

  /**
   * Stop future work and wait for every timer callback that was already
   * admitted. `stop()` remains synchronous for callers that only need the
   * admission fence; shutdown uses this draining variant.
   */
  stopAndDrain(): Promise<void> {
    if (this.stopDrainPromise) return this.stopDrainPromise;
    this.stop();
    this.stopDrainPromise = this.drainJobs();
    return this.stopDrainPromise;
  }

  private trackJob(job: Promise<void>): void {
    this.activeJobs.add(job);
    const remove = (): void => {
      this.activeJobs.delete(job);
    };
    void job.then(remove, remove);
  }

  private async drainJobs(): Promise<void> {
    const failures: unknown[] = [];
    while (this.activeJobs.size > 0) {
      const results = await Promise.allSettled([...this.activeJobs]);
      failures.push(
        ...results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason),
      );
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "scheduler shutdown failed");
  }

  private startMemoryTimers(): void {
    if (!this.memoryEngine) return;

    // Wire a model-driven extractor when the dispatcher supports internal turns.
    if (this.dispatcher.enqueueInternalTurn !== undefined) {
      this.memoryEngine.dreaming.setExtractor(this.createModelExtractor());
    }

    // Transcript sync: lightweight, runs frequently, capped per tick.
    if (Number.isFinite(this.transcriptSyncIntervalMs)) {
      this.memoryTimers.push(
        this.clock.setInterval(() => {
          this.trackJob(
            this.memoryEngine!.syncTranscripts({ maxDurationMs: DEFAULT_TRANSCRIPT_SYNC_MAX_MS })
              .then(() => undefined)
              .catch((err) => {
                log.warn("scheduled transcript sync failed", { error: String(err) });
              }),
          );
        }, this.transcriptSyncIntervalMs),
      );
    }

    // Dreaming light sleep: per-Conversation cursor advancement.
    if (Number.isFinite(this.dreamingLightIntervalMs)) {
      this.memoryTimers.push(
        this.clock.setInterval(() => {
          this.trackJob(this.runDreamingLightSleep());
        }, this.dreamingLightIntervalMs),
      );
    }

    // REM and deep sleep: global consolidation and theme detection. Align the
    // first occurrence to the configured local time; subsequent runs repeat by
    // the configured interval.
    this.startAlignedMemoryTimer(
      DEFAULT_REM_LOCAL_TIME,
      this.dreamingRemIntervalMs,
      () => {
        this.trackJob(
          this.memoryEngine!.dreaming.runRemSleep().catch((err) => {
            log.warn("scheduled REM sleep failed", { error: String(err) });
          }),
        );
      },
    );

    this.startAlignedMemoryTimer(
      DEFAULT_DEEP_LOCAL_TIME,
      this.dreamingDeepIntervalMs,
      () => {
        this.trackJob(
          this.memoryEngine!.dreaming.runDeepSleep().catch((err) => {
            log.warn("scheduled deep sleep failed", { error: String(err) });
          }),
        );
      },
    );
  }

  /**
   * Schedule a daily memory phase. The first invocation is delayed to the next
   * occurrence of `localTime` after startup; subsequent invocations repeat every
   * `intervalMs`. `localTime` is interpreted in the machine's local timezone.
   */
  private startAlignedMemoryTimer(
    localTime: { hour: number; minute: number },
    intervalMs: number,
    fn: () => void,
  ): void {
    if (!Number.isFinite(intervalMs)) return;

    const now = new Date(this.clock.now());
    const target = new Date(now);
    target.setHours(localTime.hour, localTime.minute, 0, 0);
    let delay = target.getTime() - now.getTime();
    if (delay <= 0) {
      delay += 24 * 60 * 60 * 1000;
    }

    let initialTimer = this.clock.setInterval(() => {
      initialTimer.clear();
      fn();
      if (!this.memorySchedulingOpen) return;
      const repeatTimer = this.clock.setInterval(fn, intervalMs);
      this.memoryTimers.push(repeatTimer);
    }, delay);
    this.memoryTimers.push(initialTimer);
  }

  private createModelExtractor(): CandidateExtractor {
    return async (lines, ctx) => {
      const conversationId = ctx.sessionId;
      const prompt = this.buildDreamingPrompt(conversationId, lines);
      const raw = await this.runInternalTurnForDreaming(prompt);
      return this.parseDreamingResponse(raw, conversationId, lines);
    };
  }

  private runInternalTurnForDreaming(prompt: string): Promise<string> {
    // The dreaming extractor uses one fixed Surface-free internal session. Its
    // prompt carries the source Conversation transcript excerpt, so internal
    // runtime identity does not vary by Conversation.
    const id: InternalSessionId = "__goblin_dreaming__";
    const internalSession = this.internalSessionStore.ensure(id);
    return new Promise((resolve, reject) => {
      this.dispatcher.enqueueInternalTurn!(internalSession, prompt, resolve, reject);
    });
  }

  private buildDreamingPrompt(conversationId: string, lines: TranscriptLine[]): string {
    const formatted = lines
      .map((line) => `[${line.index}] [${line.role}] ${line.text}`)
      .join("\n");
    return `You are the memory-dreaming extractor for a personal Telegram assistant. Review the transcript excerpt and identify durable memory candidates.

Rules:
- Extract only explicitly stated facts, short-term notes, recurring themes, commitments, standing orders, or anything that should be persisted.
- Do not infer commitments or standing orders the user did not explicitly state.
- Do not include procedural chit-chat, greetings, thanks, or questions.
- category must be one of: "fact", "short_term", "theme", "commitment", "standing_order", "skip".
- Use "skip" for anything that should not be persisted.
- target is one of "memory" (default), "user" (preferences/communication style), or "agent" (named agent persona).
- confidence is 0.0-1.0.
- text is the durable memory verbatim as a concise statement.
- rationale is an optional short reason for the choice.
- lineRange is an optional [start, end] logical line index range from the transcript excerpt for provenance.

Return ONLY a JSON object in this exact format:
{
  "candidates": [
    {
      "target": "memory" | "user" | "agent",
      "category": "...",
      "confidence": 0.0,
      "text": "string",
      "rationale": "string",
      "lineRange": [0, 0]
    }
  ]
}

Transcript excerpt for Conversation ${conversationId}:
${formatted}`;
  }

  private parseDreamingResponse = (raw: string, conversationId: string, lines: TranscriptLine[]): Candidate[] => {
    const cleaned = raw
      .replace(/```(?:json)?\n([\s\S]*?)\n```/, "$1")
      .replace(/^```(?:json)?\s*/, "")
      .replace(/```\s*$/, "")
      .trim();

    const quarantineMalformed = (preview: string): void => {
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: conversationId,
        targetScope: `transcript/${conversationId}`,
        category: null,
        reason: "malformed",
        content: preview,
        previewMaxLen: 200,
      });
    };

    if (cleaned.length === 0) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      quarantineMalformed(cleaned);
      return [];
    }

    if (typeof parsed !== "object" || parsed === null || !("candidates" in parsed)) {
      quarantineMalformed(cleaned);
      return [];
    }
    const candidates = (parsed as Record<string, unknown>).candidates;
    if (!Array.isArray(candidates)) {
      quarantineMalformed(cleaned);
      return [];
    }

    const defaultStart = lines[0]?.index ?? 0;
    const defaultEnd = lines[lines.length - 1]?.index ?? defaultStart;

    function lineForIndex(index: number): TranscriptLine | undefined {
      return lines.find((l) => l.index === index);
    }

    function roleForLine(line: TranscriptLine | undefined): Candidate["source"]["sourceRole"] {
      switch (line?.role) {
        case "user":
          return "user";
        case "assistant":
          return "assistant";
        case "toolResult":
          return "tool";
        default:
          return "system";
      }
    }

    const result: Candidate[] = [];
    for (const item of candidates) {
      if (typeof item !== "object" || item === null) {
        quarantineMalformed(JSON.stringify(item));
        continue;
      }
      const c = item as Record<string, unknown>;
      const rawTarget = c.target;
      // `target` is optional per spec — defaults to "memory" when absent.
      // A present-but-invalid value is malformed and quarantined below.
      const target: Candidate["target"] | undefined =
        rawTarget === undefined
          ? "memory"
          : rawTarget === "user" || rawTarget === "memory" || rawTarget === "agent"
            ? rawTarget
            : undefined;
      const rawCategory = typeof c.category === "string" ? c.category : undefined;
      const category: DreamingCategory | undefined =
        rawCategory !== undefined && (DREAMING_CATEGORIES as readonly string[]).includes(rawCategory)
          ? (rawCategory as DreamingCategory)
          : undefined;
      const rawConfidence =
        typeof c.confidence === "number"
          ? c.confidence
          : Number.parseFloat(String(c.confidence));
      const confidence =
        Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
          ? rawConfidence
          : undefined;
      const textValue =
        typeof c.text === "string" ? c.text.trim() : typeof c.summary === "string" ? c.summary.trim() : undefined;

      const rawLineRange =
        Array.isArray(c.lineRange) && c.lineRange.length === 2 ? c.lineRange : undefined;
      const lineRange: [number, number] | undefined =
        rawLineRange !== undefined &&
        typeof rawLineRange[0] === "number" &&
        Number.isFinite(rawLineRange[0]) &&
        typeof rawLineRange[1] === "number" &&
        Number.isFinite(rawLineRange[1]) &&
        rawLineRange[0] <= rawLineRange[1]
          ? [rawLineRange[0], rawLineRange[1]]
          : undefined;

      if (c.lineRange !== undefined && lineRange === undefined) {
        quarantineMalformed(JSON.stringify(item));
        continue;
      }

      if (
        target === undefined ||
        category === undefined ||
        confidence === undefined ||
        textValue === undefined ||
        textValue.length === 0
      ) {
        quarantineMalformed(JSON.stringify(item));
        continue;
      }

      const start = lineRange?.[0] ?? defaultStart;
      const end = lineRange?.[1] ?? defaultEnd;
      const startLine = lineForIndex(start);
      const sourceRole = roleForLine(startLine);

      result.push({
        target,
        category,
        confidence,
        text: textValue,
        source: {
          // Candidate is a memory-owned compatibility contract whose persisted
          // field remains `sessionId`; the value is a Conversation ID.
          sessionId: conversationId,
          lineRange: [start, end],
          sourceRole,
        },
      });
    }
    return result;
  };

  private async runDreamingLightSleep(): Promise<void> {
    if (!this.memoryEngine) return;
    const conversations = this.conversationCatalog.list();
    for (const conversation of conversations) {
      try {
        await this.memoryEngine.dreaming.runLightSleep(conversation.id);
      } catch (err) {
        log.warn("scheduled dreaming light sleep failed", {
          conversationId: conversation.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Run one tick synchronously up to dispatch, then await all dispatched
   * work. Public so tests can drive a single tick deterministically. Each
   * due schedule is claimed before its prompt is dispatched so overlapping
   * ticks do not double-dispatch the same occurrence.
   */
  async tick(): Promise<void> {
    // Guard against re-entrant ticks: a slow tick should not pile up. The
    // 60s interval makes this rare, but the guard keeps semantics predictable.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowIso = new Date(this.clock.now()).toISOString();
      const due = this.store.listDue(nowIso);
      // Each schedule is processed in isolation: a throw from one schedule
      // (e.g. a non-ENOENT HEARTBEAT.md read error, a synchronous dispatcher
      // bug) MUST NOT skip the remaining due schedules in this tick. Prompt
      // resolution occurs after claimDue, so processOne records the failed
      // occurrence before rethrowing to this isolation boundary.
      for (const schedule of due) {
        try {
          await this.processOne(schedule, nowIso);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("scheduler schedule failed within tick", {
            id: schedule.id,
            error: msg,
          });
        }
      }
    } catch (err) {
      // A tick error MUST NOT crash the bot or stop future ticks.
      const msg = err instanceof Error ? err.message : String(err);
      log.error("scheduler tick failed", { error: msg });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Validate, claim, and dispatch a single due schedule. Binding is inspected
   * before claiming so an unbound Surface does not advance, complete, or
   * disable an occurrence — it remains pending. Once claimed, the turn is
   * dispatched through the Surface's current Conversation runtime; if the
   * runtime is displaced before execution, the stale-runner guard drops the
   * captured work without re-enabling the schedule.
   */
  private async processOne(schedule: ScheduledTurn, nowIso: string): Promise<void> {
    // Resolve late through the lifecycle. This reconciles pending assignment
    // under the transition lock but never creates Conversation history.
    const conversation = await this.lifecycle.resolveCurrent(schedule.surface);

    if (conversation === null) {
      // Surface is unbound. Emit a single pending signal per (scheduleId,
      // nextRunAt) and leave the occurrence due and enabled.
      if (schedule.lastRun?.outcome !== "pending" || schedule.lastRun.message !== schedule.nextRunAt) {
        this.store.recordRun(schedule.id, { at: nowIso, outcome: "pending", message: schedule.nextRunAt });
        log.info("scheduler pending unbound schedule", {
          id: schedule.id,
          surfaceId: surfaceId(schedule.surface),
          nextRunAt: schedule.nextRunAt,
        });
      }
      return;
    }

    // Claim before dispatch. For one-shot this completes/disables; for
    // recurring this advances nextRunAt. If another tick already claimed it,
    // claimDue returns null and we skip.
    //
    // Scheduler and runtime admission gates: if shutdown has begun, do NOT
    // claim — claiming would consume a one-shot occurrence as though it ran.
    // The scheduler-owned fence is closed synchronously by stop(), including
    // for a tick already awaiting resolveCurrent(). There is
    // no await between this check and the dispatch below, so once admission is
    // open here the enqueue cannot be rejected by a later close in the same
    // synchronous sequence. The occurrence stays due (enabled) using existing
    // scheduler semantics; on a normal shutdown the loop is stopping, so this
    // is the narrow interrupted case rather than a new outcome type.
    if (!this.claimsOpen || !this.dispatcher.runtimeAdmissionOpen()) {
      log.info("scheduler skipped due schedule: admission closed", {
        id: schedule.id,
        surfaceId: surfaceId(schedule.surface),
      });
      return;
    }
    const claimed = this.store.claimDue(schedule.id, nowIso);
    if (!claimed) return;

    // The prompt text is decided after binding validation: a heartbeat resolves
    // its body from `$GOBLIN_HOME/state/surfaces/<SurfaceId>/HEARTBEAT.md`
    // (then global, then constant) using the owning Surface; a user schedule
    // uses its captured prompt.
    //
    // Binding is valid: dispatch the prompt as a fresh turn through the current
    // Conversation runtime. The dispatcher serializes through the per-Conversation
    // queue, so a scheduled turn waits behind any in-flight turn. Async prompt
    // failures are reported via the onError callback (records outcome: "error").
    // Prompt resolution and a synchronous dispatcher throw both occur after the
    // claim, so catch, record "error", and re-throw — the per-schedule catch in
    // tick() logs it, the remaining due schedules in this tick still run, and
    // future ticks continue.
    try {
      const isHeartbeat = schedule.kind === "heartbeat";
      const prompt = isHeartbeat ? resolveHeartbeatPrompt(this.home, schedule.surface) : schedule.prompt ?? "";
      const admission = this.dispatcher.enqueueScheduledTurn(conversation, schedule.surface, prompt, (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("scheduled turn failed", { error: msg, id: schedule.id });
        this.store.recordRun(schedule.id, {
          at: new Date(this.clock.now()).toISOString(),
          outcome: "error",
          message: msg,
        });
      });
      const admitted = typeof admission === "boolean" ? admission : admission.accepted;
      if (!admitted) {
        // Runtime admission closed between the gate above and enqueue. There
        // is no await in that span, so this is unreachable in practice; defend
        // anyway by NOT recording a successful outcome for rejected work.
        log.error("scheduler dispatch rejected at runtime boundary after claim", {
          id: schedule.id,
        });
        return;
      }
      if (typeof admission !== "boolean") {
        // Do not make a scheduler tick wait behind an unrelated active turn.
        // The admission promise settles when this queue entry reaches the
        // front, or false when shutdown fences it before then.
        this.trackJob(admission.started.then((started) => {
          if (!started) {
            const restored = this.store.restoreClaim(schedule.id, schedule, claimed);
            log.info("scheduler restored shutdown-fenced occurrence", {
              id: schedule.id,
              surfaceId: surfaceId(schedule.surface),
              restored,
            });
            return;
          }
          this.store.recordRun(schedule.id, {
            at: new Date(this.clock.now()).toISOString(),
            outcome: "ok",
          });
        }, (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.store.recordRun(schedule.id, {
            at: new Date(this.clock.now()).toISOString(),
            outcome: "error",
            message: msg,
          });
          log.error("scheduler admission status failed", { id: schedule.id, error: msg });
        }));
      } else if (admission) {
        // Boolean admission is retained for small/legacy dispatchers that do
        // not expose a start handle. Treat acceptance as synchronous execution
        // for that compatibility path; production TurnDispatcher always
        // returns the started handle above.
        this.store.recordRun(schedule.id, {
          at: new Date(this.clock.now()).toISOString(),
          outcome: "ok",
        });
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordRun(schedule.id, { at: nowIso, outcome: "error", message: msg });
      log.error("scheduler dispatch threw synchronously", {
        id: schedule.id,
        error: msg,
      });
      throw err;
    }
  }

}

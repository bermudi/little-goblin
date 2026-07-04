import { log } from "../log.ts";
import type { ChatLocator, SessionManager, SessionState } from "../sessions/mod.ts";
import type { TurnDispatcher } from "../tg/turn-dispatcher.ts";
import type { ScheduledTurn } from "./types.ts";
import type { ScheduleStore } from "./store.ts";

/**
 * Default scheduler tick interval: 60 seconds. Bounds worst-case delivery
 * latency to ~60s, well inside the granularity users care about for a personal
 * assistant. Not configurable in v1 (see design decision "Scheduler ticks
 * every 60 seconds"). Exposed as a named constant so tests and future config
 * can reference it.
 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * The system-owned heartbeat prompt. The `[heartbeat]` prefix makes the prompt
 * distinguishable from user-authored text at the agent layer and in
 * transcripts. The body MUST NOT claim a user asked a new question.
 *
 * Pinned here (not constructed dynamically) so drift cannot quietly violate
 * the "MUST NOT claim a user asked a new question" rule.
 */
export const HEARTBEAT_PROMPT =
  "[heartbeat] This is a scheduled self-check-in. No user message prompted this turn. Review the current session context and decide whether there is anything useful, timely, or important to say. If there is nothing worth saying, reply briefly that you have nothing to add and stop.";

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
  enqueueScheduledTurn(
    session: SessionState,
    locator: ChatLocator,
    content: string,
    onError?: (err: unknown) => void,
  ): void;
}

export interface SchedulerOptions {
  store: ScheduleStore;
  manager: SessionManager;
  dispatcher: SchedulerDispatcher | TurnDispatcher;
  clock?: SchedulerClock;
  tickIntervalMs?: number;
}

/**
 * Single-process scheduler loop. Polls the schedule store for due enabled
 * schedules, claims each due schedule one at a time within a tick, validates
 * the captured binding via `SessionManager.peekBinding` (never `resolve()`),
 * disables stale/mismatched/archived schedules with a `LastRunStatus`, and
 * dispatches valid prompts through the shared turn dispatcher.
 *
 * Lifecycle:
 *   - `start()` begins ticking after `manager.init()` has completed (caller's
 *     responsibility to order).
 *   - `stop()` clears the timer; in-flight ticks may finish but no new due
 *     schedules are dispatched after stop begins.
 *   - Tick errors are logged and swallowed so future ticks continue.
 */
export class SchedulerLoop {
  private readonly store: ScheduleStore;
  private readonly manager: SessionManager;
  private readonly dispatcher: SchedulerDispatcher;
  private readonly clock: SchedulerClock;
  private readonly tickIntervalMs: number;
  private timer: { clear(): void } | null = null;
  private ticking = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.manager = options.manager;
    this.dispatcher = options.dispatcher;
    this.clock = options.clock ?? realClock;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /** Begin ticking. No-op if already started. */
  start(): void {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    log.info("scheduler started", { tickIntervalMs: this.tickIntervalMs });
  }

  /** Stop ticking. No-op if not started. Safe to call during shutdown. */
  stop(): void {
    if (!this.timer) return;
    this.timer.clear();
    this.timer = null;
    log.info("scheduler stopped");
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
      for (const schedule of due) {
        await this.processOne(schedule, nowIso);
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
   * Claim, validate, and dispatch a single due schedule. Claiming happens
   * before binding validation so that even a mismatching schedule is marked
   * claimed (one-shot completed / recurring advanced) and cannot tight-loop.
   * Stale bindings are recorded via `recordRun` with the appropriate outcome.
   */
  private async processOne(schedule: ScheduledTurn, nowIso: string): Promise<void> {
    // The prompt text is decided before claiming: a heartbeat uses the
    // system-owned constant; a user schedule uses its captured prompt.
    const isHeartbeat = schedule.kind === "heartbeat";
    const prompt = isHeartbeat ? HEARTBEAT_PROMPT : schedule.prompt ?? "";

    // Claim before dispatch. For one-shot this completes/disables; for
    // recurring this advances nextRunAt. If another tick already claimed it,
    // claimDue returns null and we skip.
    const claimed = this.store.claimDue(schedule.id, nowIso);
    if (!claimed) return;

    // Validate the captured binding via the NON-MUTATING peek. Never resolve(),
    // which auto-creates sessions for topic/supergroup locators.
    const peeked = this.manager.peekBinding(schedule.locator);

    if (peeked === null) {
      // No binding resolves to a live session. Distinguish archived (the
      // session dir is gone) from a generic mismatch. Both disable the
      // schedule; the outcome label differs for diagnostics.
      const outcome = this.isArchived(schedule.sessionId) ? "archived" : "binding-mismatch";
      this.store.recordRun(schedule.id, { at: nowIso, outcome });
      log.info("scheduler disabled stale schedule", {
        id: schedule.id,
        outcome,
        sessionId: schedule.sessionId,
      });
      return;
    }

    if (peeked.sessionId !== schedule.sessionId) {
      // Locator is bound to a different session now (e.g. /new, /resume).
      this.store.recordRun(schedule.id, { at: nowIso, outcome: "binding-mismatch" });
      log.info("scheduler disabled rebound schedule", {
        id: schedule.id,
        capturedSessionId: schedule.sessionId,
        currentSessionId: peeked.sessionId,
      });
      return;
    }

    // Binding is valid: dispatch the prompt as a fresh turn. The dispatcher
    // serializes through the per-session queue, so a scheduled turn waits
    // behind any in-flight turn. Async prompt failures are reported via the
    // onError callback (records outcome: "error"). A synchronous throw from
    // enqueueScheduledTurn (a dispatcher bug) would otherwise leave the
    // schedule claimed with no last-run status, so we catch, record "error",
    // and re-throw — the outer tick catch logs it and future ticks continue.
    try {
      this.dispatcher.enqueueScheduledTurn(peeked.state, schedule.locator, prompt, (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordRun(schedule.id, {
          at: new Date(this.clock.now()).toISOString(),
          outcome: "error",
          message: msg,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordRun(schedule.id, { at: nowIso, outcome: "error", message: msg });
      log.error("scheduler dispatch threw synchronously", {
        id: schedule.id,
        error: msg,
      });
      throw err;
    }
    this.store.recordRun(schedule.id, { at: nowIso, outcome: "ok" });
  }

  /**
   * Precisely check whether the captured session was archived via
   * `manager.archive()` (binding cleared + dir moved). A manually-deleted
   * session dir is NOT archived, so the scheduler labels it "binding-mismatch"
   * — matching the spec's archived-scenario definition. Delegates to
   * `SessionManager.isArchived`, a single `existsSync` rather than the O(n×m)
   * `manager.list()` scan the prior heuristic used.
   */
  private isArchived(sessionId: string): boolean {
    return this.manager.isArchived(sessionId);
  }
}

import { readFileSync } from "node:fs";
import { log } from "../log.ts";
import { heartbeatMdPath } from "../workspace/paths.ts";
import { heartbeatMdPathForSession } from "../sessions/paths.ts";
import type { ChatLocator, SessionState } from "../sessions/mod.ts";
import type { ActiveScope } from "../memory/scope.ts";
import type { MemoryEngine } from "../memory/engine.ts";
import { ENTRY_CATEGORIES } from "../memory/entry.ts";
import type { Candidate, CandidateExtractor } from "../memory/dreaming.ts";
import type { TranscriptLine } from "../sessions/transcript.ts";
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
export const DEFAULT_TRANSCRIPT_SYNC_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_TRANSCRIPT_SYNC_INTERVAL_MINUTES", 5);
export const DEFAULT_TRANSCRIPT_SYNC_MAX_MS = 30_000;
export const DEFAULT_DREAMING_LIGHT_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL_MINUTES", 4 * 60);
export const DEFAULT_DREAMING_REM_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_DREAM_REM_INTERVAL_MINUTES", 24 * 60);
export const DEFAULT_DREAMING_DEEP_INTERVAL_MS = parseIntervalMinutes("GOBLIN_MEMORY_DREAM_DEEP_INTERVAL_MINUTES", 24 * 60);

const DEFAULT_REM_LOCAL_TIME = parseLocalTime("GOBLIN_MEMORY_DREAM_REM_LOCAL_TIME", "03:00");
const DEFAULT_DEEP_LOCAL_TIME = parseLocalTime("GOBLIN_MEMORY_DREAM_DEEP_LOCAL_TIME", "04:00");

function parseIntervalMinutes(key: string, fallbackMinutes: number): number {
  const raw = process.env[key];
  if (raw === "off") return Number.POSITIVE_INFINITY;
  if (raw === undefined) return fallbackMinutes * 60_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : fallbackMinutes * 60_000;
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
  "[heartbeat] This is a scheduled self-check-in. No user message prompted this turn. Review the current session context and decide whether there is anything useful, timely, or important to say. If there is nothing worth saying, reply briefly that you have nothing to add and stop.";

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
 * Resolve the heartbeat prompt body for a given session.
 *
 * Checks candidates in first-non-empty-wins order:
 * 1. `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md`
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

export function resolveHeartbeatPrompt(home: string, sessionId: string): string {
  const sessionBody = readCandidate(heartbeatMdPathForSession(home, sessionId));
  if (sessionBody !== null) return `[heartbeat] ${stripLeadingHeartbeat(sessionBody)}`;
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
  enqueueScheduledTurn(
    session: SessionState,
    locator: ChatLocator,
    content: string,
    onError?: (err: unknown) => void,
  ): void;
  enqueueInternalTurn?(
    session: SessionState,
    content: string,
    onComplete: (text: string) => void,
    onError: (err: unknown) => void,
  ): void;
}

/**
 * The minimal session surface the scheduler needs: a non-mutating binding
 * peek and an archived check. `SessionManager` satisfies this structurally
 * (its `peekBinding(loc, opts?)` accepts an optional second arg the seam
 * omits — scheduled turns never carry `isGuest`). Injected so eligibility
 * tests can fake sessions without a filesystem.
 */
export interface SchedulerSessionSource {
  peekBinding(loc: ChatLocator): { sessionId: string; state: SessionState } | null;
  isArchived(sessionId: string): boolean;
  list?(): SessionState[];
  ensureInternal?(id: string): SessionState;
}

export interface SchedulerOptions {
  store: ScheduleStore;
  sessionSource: SchedulerSessionSource;
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
  private readonly sessionSource: SchedulerSessionSource;
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

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.sessionSource = options.sessionSource;
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
    this.timer = this.clock.setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    this.startMemoryTimers();
    log.info("scheduler started", { tickIntervalMs: this.tickIntervalMs });
  }

  /** Stop ticking. No-op if not started. Safe to call during shutdown. */
  stop(): void {
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
          void this.memoryEngine!.syncTranscripts({ maxDurationMs: DEFAULT_TRANSCRIPT_SYNC_MAX_MS }).catch((err) => {
            log.warn("scheduled transcript sync failed", { error: String(err) });
          });
        }, this.transcriptSyncIntervalMs),
      );
    }

    // Dreaming light sleep: per-session cursor advancement.
    if (Number.isFinite(this.dreamingLightIntervalMs)) {
      this.memoryTimers.push(
        this.clock.setInterval(() => {
          void this.runDreamingLightSleep();
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
        void this.memoryEngine!.dreaming.runRemSleep().catch((err) => {
          log.warn("scheduled REM sleep failed", { error: String(err) });
        });
      },
    );

    this.startAlignedMemoryTimer(
      DEFAULT_DEEP_LOCAL_TIME,
      this.dreamingDeepIntervalMs,
      () => {
        void this.memoryEngine!.dreaming.runDeepSleep().catch((err) => {
          log.warn("scheduled deep sleep failed", { error: String(err) });
        });
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
      const repeatTimer = this.clock.setInterval(fn, intervalMs);
      this.memoryTimers.push(repeatTimer);
    }, delay);
    this.memoryTimers.push(initialTimer);
  }

  private createModelExtractor(): CandidateExtractor {
    return async (lines, ctx) => {
      const prompt = this.buildDreamingPrompt(ctx.sessionId, lines);
      const raw = await this.runInternalTurnForDreaming(ctx.sessionId, prompt);
      return this.parseDreamingResponse(raw, ctx.sessionId);
    };
  }

  private runInternalTurnForDreaming(_sessionId: string, prompt: string): Promise<string> {
    // The dreaming subagent uses a single fixed internal session. The prompt
    // carries the per-user-session transcript excerpt, so the session id does
    // not need to vary per chat.
    const id = "__goblin_dreaming__";
    const session: SessionState = this.sessionSource.ensureInternal?.(id) ?? {
      id,
      createdAt: new Date().toISOString(),
      chatId: 0,
    };
    return new Promise((resolve, reject) => {
      this.dispatcher.enqueueInternalTurn!(session, prompt, resolve, reject);
    });
  }

  private buildDreamingPrompt(sessionId: string, lines: TranscriptLine[]): string {
    const formatted = lines
      .map((line) => `[${line.index}] [${line.role}] ${line.text}`)
      .join("\n");
    return `You are the memory-dreaming extractor for a personal Telegram assistant. Review the transcript excerpt and identify durable memory candidates.

Rules:
- Extract only explicitly stated facts, preferences, decisions, conventions, gotchas, commitments, standing orders, or recurring themes.
- Do not infer commitments or standing orders the user did not explicitly state.
- Do not include procedural chit-chat, greetings, thanks, or questions.
- category must be one of: "fact", "short_term", "theme", "commitment", "standing_order", "preference", "decision", "project_fact", "gotcha", "convention", "skip".
- Use "skip" for anything that should not be persisted.
- target "user" for user preferences/communication style; target "memory" for project/session facts, decisions, conventions, gotchas, commitments, standing orders.
- confidence is 0.0-1.0.
- lineRange is the [start, end] logical line indices from the transcript (inclusive).

Return ONLY a JSON object in this exact format:
{
  "candidates": [
    {
      "target": "user" | "memory",
      "category": "...",
      "confidence": 0.0,
      "summary": "string",
      "lineRange": [0, 0]
    }
  ]
}

Transcript excerpt for session ${sessionId}:
${formatted}`;
  }

  private parseDreamingResponse(raw: string, sessionId: string): Candidate[] {
    const cleaned = raw
      .replace(/```(?:json)?\n([\s\S]*?)\n```/, "$1")
      .replace(/^```(?:json)?\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
    if (cleaned.length === 0) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      log.warn("dreaming model response was not valid JSON", { sessionId, response: cleaned.slice(0, 200) });
      return [];
    }

    if (typeof parsed !== "object" || parsed === null || !("candidates" in parsed)) {
      return [];
    }
    const candidates = (parsed as Record<string, unknown>).candidates;
    if (!Array.isArray(candidates)) return [];

    const result: Candidate[] = [];
    for (const item of candidates) {
      if (typeof item !== "object" || item === null) continue;
      const c = item as Record<string, unknown>;
      const target = c.target === "user" || c.target === "memory" ? c.target : undefined;
      const rawCategory = typeof c.category === "string" ? c.category : undefined;
      const category =
        rawCategory !== undefined &&
        (ENTRY_CATEGORIES as readonly string[]).includes(rawCategory)
          ? rawCategory
          : undefined;
      const rawConfidence =
        typeof c.confidence === "number"
          ? c.confidence
          : Number.parseFloat(String(c.confidence));
      const confidence =
        Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
          ? rawConfidence
          : undefined;
      const summary = typeof c.summary === "string" ? c.summary.trim() : undefined;
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
      if (
        target === undefined ||
        category === undefined ||
        confidence === undefined ||
        summary === undefined ||
        summary.length === 0 ||
        lineRange === undefined
      ) {
        continue;
      }
      result.push({
        target,
        category: category as Candidate["category"],
        confidence,
        summary,
        source: {
          sessionId,
          lineRange,
          sourceRole: "system",
        },
      });
    }
    return result;
  }

  private async runDreamingLightSleep(): Promise<void> {
    if (!this.memoryEngine) return;
    const sessions = this.sessionSource.list?.() ?? [];
    for (const session of sessions) {
      if (session.chatId === 0) continue;
      const activeScope: ActiveScope = {
        chatId: session.chatId,
        topicScope: session.topicId !== undefined ? { topicId: session.topicId } : "general",
        namedAgent: null,
      };
      try {
        await this.memoryEngine.dreaming.runLightSleep(session.id, activeScope);
      } catch (err) {
        log.warn("scheduled dreaming light sleep failed", {
          sessionId: session.id,
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
      // bug) MUST NOT skip the remaining due schedules in this tick. Without
      // this, a mis-permissioned heartbeat — which re-dues every tick because
      // it is resolved before claimDue — would starve every other schedule
      // until an operator fixes the file.
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
   * Claim, validate, and dispatch a single due schedule. Claiming happens
   * before binding validation so that even a mismatching schedule is marked
   * claimed (one-shot completed / recurring advanced) and cannot tight-loop.
   * Stale bindings are recorded via `recordRun` with the appropriate outcome.
   */
  private async processOne(schedule: ScheduledTurn, nowIso: string): Promise<void> {
    // The prompt text is decided before claiming: a heartbeat resolves its
    // body from `$GOBLIN_HOME/state/sessions/<id>/HEARTBEAT.md` (then global,
    // then constant) at dispatch time; a user schedule uses its captured prompt.
    const isHeartbeat = schedule.kind === "heartbeat";
    const prompt = isHeartbeat ? resolveHeartbeatPrompt(this.home, schedule.sessionId) : schedule.prompt ?? "";

    // Claim before dispatch. For one-shot this completes/disables; for
    // recurring this advances nextRunAt. If another tick already claimed it,
    // claimDue returns null and we skip.
    const claimed = this.store.claimDue(schedule.id, nowIso);
    if (!claimed) return;

    // Validate the captured binding via the NON-MUTATING peek. Never resolve(),
    // which auto-creates sessions for topic/supergroup locators.
    const peeked = this.sessionSource.peekBinding(schedule.locator);

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
    // and re-throw — the per-schedule catch in tick() logs it, the remaining
    // due schedules in this tick still run, and future ticks continue.
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
    return this.sessionSource.isArchived(sessionId);
  }
}

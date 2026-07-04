import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";
import { schedulesPath } from "../sessions/paths.ts";
import type { ChatLocator } from "../sessions/types.ts";
import type { LastRunStatus, ScheduleKind, ScheduleStoreFile, ScheduleState, ScheduledTurn } from "./types.ts";

/**
 * Default heartbeat interval: 30 minutes. Used by the command layer when the
 * user enables heartbeat without specifying an interval. Defined here so the
 * store and command surfaces agree on the default.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Generate a short schedule id from a UUID. Mirrors `makeSessionId()` — 10
 * hex chars (16^10 ≈ 1.1 trillion combos), fs-safe and user-typable.
 */
export function makeScheduleId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

const EMPTY_STORE: ScheduleStoreFile = { schedules: [] };

function pathFor(home: string): string {
  return schedulesPath(home);
}

/**
 * Load the schedule store. Returns an empty store when the file is missing
 * (ENOENT is expected — first run). Malformed JSON logs a warning and yields
 * an empty store so the bot keeps running; everything else propagates.
 */
export function loadStore(home: string): ScheduleStoreFile {
  try {
    const raw = readFileSync(pathFor(home), "utf-8");
    return JSON.parse(raw) as ScheduleStoreFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_STORE);
    }
    if (e instanceof SyntaxError) {
      log.warn("schedules.json malformed, treating as empty", { error: e.message });
      return structuredClone(EMPTY_STORE);
    }
    throw e;
  }
}

/**
 * Save the store atomically via `atomicWrite` (tmp + fsync + rename).
 */
export function saveStore(home: string, store: ScheduleStoreFile): void {
  atomicWrite(pathFor(home), JSON.stringify(store, null, 2) + "\n");
}

/**
 * Mutable schedule store. Backed by `schedulesPath(home)` with atomic writes.
 *
 * Operations take the active `sessionId` so that remove/pause/resume enforce
 * active-session ownership: a schedule can only be mutated by the session that
 * owns it. Cross-session mutations return null/false rather than throwing.
 */
export class ScheduleStore {
  private readonly generateId: () => string;

  constructor(
    private readonly home: string,
    /**
     * Optional id generator, primarily for tests that need to force collisions
     * to exercise `freshId`'s fallback path. Defaults to `makeScheduleId`.
     */
    generateId: () => string = makeScheduleId,
  ) {
    this.generateId = generateId;
  }

  private read(): ScheduleStoreFile {
    return loadStore(this.home);
  }

  private write(store: ScheduleStoreFile): void {
    saveStore(this.home, store);
  }

  /**
   * List every schedule owned by a session, including enabled, disabled, and
   * completed records. Sorted by nextRunAt for stable listing, with completed
   * schedules sorted last.
   */
  listBySession(sessionId: string): ScheduledTurn[] {
    return this.read()
      .schedules.filter((s) => s.sessionId === sessionId)
      .sort((a, b) => {
        if (a.state === "completed" && b.state !== "completed") return 1;
        if (b.state === "completed" && a.state !== "completed") return -1;
        return a.nextRunAt.localeCompare(b.nextRunAt);
      });
  }

  /**
   * Look up a single schedule by id, only if owned by the given session.
   * Returns null when missing or owned by another session — callers treat
   * both the same way ("no matching schedule was found").
   */
  getForSession(sessionId: string, id: string): ScheduledTurn | null {
    const s = this.read().schedules.find((x) => x.id === id);
    if (!s || s.sessionId !== sessionId) return null;
    return s;
  }

  /**
   * Create a one-shot or recurring schedule. Heartbeat schedules are created
   * via `setHeartbeat`. Retries id generation on collision.
   */
  create(params: {
    sessionId: string;
    locator: ChatLocator;
    kind: Exclude<ScheduleKind, "heartbeat">;
    prompt: string;
    nextRunAt: string;
    intervalMs?: number;
  }): ScheduledTurn {
    const store = this.read();
    const record: ScheduledTurn = {
      id: this.freshId(store),
      sessionId: params.sessionId,
      locator: params.locator,
      kind: params.kind,
      prompt: params.prompt,
      enabled: true,
      state: "enabled",
      nextRunAt: params.nextRunAt,
      intervalMs: params.intervalMs,
      createdAt: new Date().toISOString(),
    };
    store.schedules.push(record);
    this.write(store);
    log.info("created schedule", { id: record.id, kind: record.kind, sessionId: record.sessionId });
    return record;
  }

  /**
   * Get, create, or update the session's heartbeat schedule. When `enabled`
   * is true the heartbeat is set to the given interval (defaulting to 30 min)
   * and its next run is computed from `now`. When `enabled` is false the
   * heartbeat is disabled in place (the record is retained so status can
   * report it).
   */
  setHeartbeat(params: {
    sessionId: string;
    locator: ChatLocator;
    enabled: boolean;
    intervalMs?: number;
    now: string;
  }): ScheduledTurn {
    const store = this.read();
    const existing = store.schedules.find(
      (s) => s.kind === "heartbeat" && s.sessionId === params.sessionId,
    );

    const intervalMs = params.enabled
      ? params.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
      : existing?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

    if (existing) {
      existing.intervalMs = intervalMs;
      if (params.enabled) {
        existing.enabled = true;
        existing.state = "enabled";
        existing.nextRunAt = new Date(new Date(params.now).getTime() + intervalMs).toISOString();
      } else {
        existing.enabled = false;
        existing.state = "disabled";
      }
      this.write(store);
      return existing;
    }

    // No existing heartbeat — create only when enabling. Disabling a
    // non-existent heartbeat is a no-op that surfaces a synthesized disabled
    // record via the status command, but nothing is persisted here.
    if (!params.enabled) {
      const record: ScheduledTurn = {
        id: this.freshId(store),
        sessionId: params.sessionId,
        locator: params.locator,
        kind: "heartbeat",
        prompt: null,
        enabled: false,
        state: "disabled",
        nextRunAt: params.now,
        intervalMs,
        createdAt: new Date().toISOString(),
      };
      return record;
    }

    const record: ScheduledTurn = {
      id: this.freshId(store),
      sessionId: params.sessionId,
      locator: params.locator,
      kind: "heartbeat",
      prompt: null,
      enabled: true,
      state: "enabled",
      nextRunAt: new Date(new Date(params.now).getTime() + intervalMs).toISOString(),
      intervalMs,
      createdAt: new Date().toISOString(),
    };
    store.schedules.push(record);
    this.write(store);
    log.info("enabled heartbeat", { id: record.id, sessionId: record.sessionId, intervalMs });
    return record;
  }

  /**
   * Read the session's heartbeat schedule, or null if none exists.
   */
  getHeartbeat(sessionId: string): ScheduledTurn | null {
    return (
      this.read().schedules.find((s) => s.kind === "heartbeat" && s.sessionId === sessionId) ?? null
    );
  }

  /**
   * Remove a schedule owned by the active session. Returns true if removed,
   * false if no matching schedule exists for this session.
   */
  remove(sessionId: string, id: string): boolean {
    const store = this.read();
    const idx = store.schedules.findIndex((s) => s.id === id && s.sessionId === sessionId);
    if (idx === -1) return false;
    store.schedules.splice(idx, 1);
    this.write(store);
    log.info("removed schedule", { id, sessionId });
    return true;
  }

  /**
   * Pause (disable) a schedule owned by the active session.
   */
  pause(sessionId: string, id: string): ScheduledTurn | null {
    return this.setState(sessionId, id, "disabled");
  }

  /**
   * Resume (re-enable) a schedule owned by the active session. Does not touch
   * prompt text or interval. A completed one-shot schedule stays completed.
   */
  resume(sessionId: string, id: string): ScheduledTurn | null {
    const existing = this.getForSession(sessionId, id);
    if (!existing) return null;
    if (existing.state === "completed") return existing;
    return this.setState(sessionId, id, "enabled");
  }

  private setState(sessionId: string, id: string, state: ScheduleState): ScheduledTurn | null {
    const store = this.read();
    const s = store.schedules.find((x) => x.id === id && x.sessionId === sessionId);
    if (!s) return null;
    // Terminal-state guard: a completed one-shot has run its single
    // occurrence. Refuse any further lifecycle transition so `/schedule list`
    // keeps displaying `completed` (the list requirement) rather than silently
    // rewriting it to `disabled` via `/schedule pause`.
    if (s.state === "completed" && state !== "completed") return s;
    s.state = state;
    s.enabled = state === "enabled";
    this.write(store);
    return s;
  }

  /**
   * Read-only list of all schedules whose nextRunAt has passed and that are
   * currently enabled. The scheduler claims each one individually via
   * `claimDue` so overlapping ticks do not double-dispatch.
   */
  listDue(now: string): ScheduledTurn[] {
    const nowMs = new Date(now).getTime();
    return this.read().schedules.filter(
      (s) => s.enabled && s.state === "enabled" && new Date(s.nextRunAt).getTime() <= nowMs,
    );
  }

  /**
   * Atomically claim a due schedule for dispatch. For one-shot schedules the
   * record is marked completed and disabled before dispatch. For recurring
   * and heartbeat schedules the next run is advanced by the interval before
   * dispatch. Returns the claimed record as it will look after dispatch
   * starts (the prompt to run is recoverable from the pre-claim record via
   * `getForSession` if needed), or null if the schedule is no longer
   * claimable (another tick claimed it, or it was paused/removed).
   *
   * `nextNow` is the timestamp used to advance recurring schedules, so tests
   * can inject a deterministic clock.
   */
  claimDue(id: string, now: string): ScheduledTurn | null {
    const store = this.read();
    const s = store.schedules.find((x) => x.id === id);
    if (!s || !s.enabled || s.state !== "enabled") return null;
    const nowMs = new Date(now).getTime();
    if (new Date(s.nextRunAt).getTime() > nowMs) return null;

    if (s.kind === "once") {
      s.enabled = false;
      s.state = "completed";
    } else {
      const interval = s.intervalMs;
      if (interval === undefined) {
        // Defensive: a recurring/heartbeat record without an interval is
        // broken; disable it rather than tight-looping.
        s.enabled = false;
        s.state = "disabled";
        s.lastRun = { at: now, outcome: "error", message: "missing intervalMs" };
      } else {
        // Advance from the due time (not from now) so a delayed tick does not
        // accumulate drift, but never schedule the next run in the past.
        let nextMs = new Date(s.nextRunAt).getTime() + interval;
        while (nextMs <= nowMs) nextMs += interval;
        s.nextRunAt = new Date(nextMs).toISOString();
      }
    }
    this.write(store);
    return s;
  }

  /**
   * Record the outcome of a dispatched schedule. Used by the scheduler after
   * dispatch (or after a stale-binding skip) to persist last-run metadata.
   *
   * Terminal-state guard: a completed one-shot keeps `state: "completed"` even
   * when a binding mismatch or archived outcome is recorded after the fact —
   * the occurrence already ran, so the diagnostic outcome updates `lastRun`
   * without rewriting the terminal lifecycle label.
   */
  recordRun(id: string, status: LastRunStatus): void {
    const store = this.read();
    const s = store.schedules.find((x) => x.id === id);
    if (!s) return;
    s.lastRun = status;
    if (status.outcome === "binding-mismatch" || status.outcome === "archived") {
      s.enabled = false;
      if (s.state !== "completed") s.state = "disabled";
    }
    this.write(store);
  }

  /**
   * Generate a unique id, retrying on the astronomically unlikely collision.
   * After 8 collisions, fall back to a longer slice to guarantee uniqueness.
   */
  private freshId(store: ScheduleStoreFile): string {
    const existing = new Set(store.schedules.map((s) => s.id));
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = this.generateId();
      if (!existing.has(id)) return id;
    }
    // Extremely unlikely; fall back to a longer slice to guarantee uniqueness.
    return randomUUID().replace(/-/g, "").slice(0, 16);
  }
}

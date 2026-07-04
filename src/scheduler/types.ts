import type { ChatLocator } from "../sessions/types.ts";

/**
 * Scheduler type definitions for scheduled turns.
 *
 * Scheduled turns persist user-authored prompts (or a system-owned heartbeat
 * prompt) to run as fresh agent turns at a future time or on a recurring
 * interval. See specs/changes/scheduled-turns/ for the full design.
 */

export type ScheduleKind = "once" | "recurring" | "heartbeat";

/**
 * Lifecycle state of a schedule record.
 *
 * - `enabled`   — due work will dispatch when nextRunAt passes
 * - `disabled`  — paused by the user or disabled by a stale binding check
 * - `completed` — a one-shot schedule whose single occurrence has run
 *
 * The on-disk record also carries an `enabled: boolean` flag; `state` is the
 * authoritative lifecycle marker, while `enabled` is retained for cheap
 * filtering at the store layer.
 */
export type ScheduleState = "enabled" | "disabled" | "completed";

/**
 * Terminal status recorded the last time the scheduler touched a schedule.
 *
 * `at` is an ISO-8601 timestamp. `outcome` enumerates the scheduler's terminal
 * cases: successful dispatch, a binding mismatch (session rebound), an
 * archived session, or a generic dispatch error. Absent until the first run.
 */
export interface LastRunStatus {
  at: string;
  outcome: "ok" | "binding-mismatch" | "archived" | "error";
  message?: string;
}

/**
 * A persisted scheduled turn definition.
 *
 * `prompt` is null for heartbeat schedules (the heartbeat prompt is a
 * system-owned constant defined in the scheduler loop); user-authored text for
 * `once` and `recurring`. `intervalMs` is required for `recurring` and
 * `heartbeat` and absent for `once`.
 */
export interface ScheduledTurn {
  id: string;
  sessionId: string;
  locator: ChatLocator;
  kind: ScheduleKind;
  prompt: string | null;
  enabled: boolean;
  state: ScheduleState;
  /** ISO-8601 timestamp of the next run. */
  nextRunAt: string;
  /** Recurrence interval in milliseconds. Present for recurring/heartbeat only. */
  intervalMs?: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  lastRun?: LastRunStatus;
}

/**
 * On-disk shape of `schedules.json`. The store is a flat list keyed by id so
 * lookup, removal, and iteration are O(n) and writes stay simple.
 */
export interface ScheduleStoreFile {
  schedules: ScheduledTurn[];
}

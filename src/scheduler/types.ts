import type { Surface } from "../surface.ts";

/**
 * Scheduler type definitions for scheduled turns.
 *
 * Scheduled turns persist user-authored prompts (or a system-owned heartbeat
 * prompt) to run as fresh agent turns at a future time or on a recurring
 * interval. Historical design:
 * `specs/changes/archive/2026-07-05-scheduled-turns/`.
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
 * Maximum number of enabled agent-source schedules allowed per session. The cap
 * is enforced at the store mutation boundary for every agent-originated
 * transition into `enabled` (`create`, `resume`, `setHeartbeat(enabled: true)`).
 * User-originated schedules and disabled/completed agent schedules do not count.
 */
export const MAX_AGENT_SCHEDULES = 8;

/**
 * Terminal status recorded the last time the scheduler touched a schedule.
 *
 * `at` is an ISO-8601 timestamp. `outcome` enumerates the scheduler's terminal
 * cases: successful dispatch, a binding mismatch (session rebound), an
 * archived session, a generic dispatch error, or a pending signal emitted while
 * the owning Surface is unbound. Absent until the first run.
 */
export interface LastRunStatus {
  at: string;
  outcome: "ok" | "binding-mismatch" | "archived" | "error" | "pending";
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
  surface: Surface;
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
  /** Provenance: who created the schedule. Absent/legacy records read as "user". */
  source?: "user" | "agent";
  lastRun?: LastRunStatus;
  /**
   * Monotonic claim revision. `claimDue` increments it; `restoreClaim`
   * restores only when the on-disk revision still matches the claim it
   * issued. Optional so legacy records remain readable without a
   * state-version bump.
   */
  claimRevision?: number;
}

/**
 * On-disk DTO for a scheduled turn. The canonical on-disk representation stores
 * the surface as a validated `SurfaceId`; the in-memory model carries the
 * decoded `Surface`.
 */
export interface PersistedScheduledTurn {
  id: string;
  surfaceId: string;
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
  /** Provenance: who created the schedule. Absent/legacy records read as "user". */
  source?: "user" | "agent";
  lastRun?: LastRunStatus;
  /** Optional claim revision; absent on legacy records. */
  claimRevision?: number;
}

/**
 * On-disk shape of `schedules.json`. The store is a flat list keyed by id so
 * lookup, removal, and iteration are O(n) and writes stay simple.
 */
export interface ScheduleStoreFile {
  schedules: PersistedScheduledTurn[];
}

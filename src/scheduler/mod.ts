/**
 * Scheduler module. Owns the schedule store, scheduler loop, and time parsing
 * for scheduled turns and opt-in session heartbeat. See
 * specs/changes/scheduled-turns/ for the design.
 */

export { ScheduleStore, DEFAULT_HEARTBEAT_INTERVAL_MS, makeScheduleId, loadStore, saveStore } from "./store.ts";
export { createScheduleTurnTool } from "./tool.ts";
export type { ScheduleTurnToolArgs } from "./tool.ts";
export {
  SchedulerLoop,
  DEFAULT_TICK_INTERVAL_MS,
  HEARTBEAT_PROMPT,
} from "./loop.ts";
export type { SchedulerClock, SchedulerDispatcher, SchedulerOptions } from "./loop.ts";
export {
  parseDuration,
  parseAt,
  parseIn,
  formatDuration,
  formatRunTime,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
} from "./time.ts";
export type { ParseAtResult, ParseInResult, DurationUnit } from "./time.ts";
export type {
  ScheduleKind,
  ScheduleState,
  LastRunStatus,
  ScheduledTurn,
  ScheduleStoreFile,
} from "./types.ts";

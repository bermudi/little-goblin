# scheduler-metrics

## Motivation

The scheduler (`src/scheduler/loop.ts` and `src/scheduler/store.ts`) silently dispatches due turns, advances recurring schedules, and disables stale bindings, but it leaves no durable observability trail. Operators cannot see how many scheduled turns ran, how many were skipped because of binding drift, whether a recurring schedule is slipping relative to its interval, or how many schedule lifecycle events occurred in a session. The `session-metrics` change adds a `MetricsStore` and `metrics.jsonl` per session; this change extends that foundation specifically for scheduler observability.

## Scope

This change touches three capabilities: `metrics` (extended), `scheduler` (modified), and `commands` (modified).

### `metrics` capability

- Extend the `MetricsEvent` conventions with scheduler-scoped `event` and `counter` names. The generic store API (`record`, `incrementCounter`, `readMetricsSummary`) is unchanged; this change adds the *semantic contract* for scheduler events.
- Define `scheduler` events:
  - `scheduler_dispatch` event — `scheduleId`, `kind` (`once`/`recurring`/`heartbeat`), `source` (`user`/`agent`), `outcome` (`ok`/`binding-mismatch`/`archived`/`error`), and `errorMessage` when `outcome` is `error`.
  - `scheduler_tick` event — `dueCount`, `tickDurationMs`.
  - `scheduler_drift` event — `scheduleId`, `kind`, `driftMs` (actual dispatch time minus scheduled `nextRunAt`, positive when late), `source`.
  - `schedule_enabled` and `schedule_disabled` events — `scheduleId`, `kind`, `source`, `trigger` (`command`/`agent_tool`/`scheduler`/`system`).
  - `scheduler_missed_run` event — `scheduleId`, `kind`, `source`, `scheduledRunAt`, `missedByMs` (how far past the scheduled time the next tick is, and the `nextRunAt` has been advanced past the missed occurrence).
- Define counters:
  - `scheduler_dispatch_total`
  - `scheduler_dispatch_ok_total`
  - `scheduler_dispatch_error_total`
  - `scheduler_dispatch_binding_mismatch_total`
  - `scheduler_dispatch_archived_total`
  - `scheduler_tick_total`
  - `scheduler_late_run_total` (count of dispatches where `driftMs > 0`)
  - `scheduler_missed_run_total`
  - `scheduler_schedule_enabled_total`
  - `scheduler_schedule_disabled_total`
- Extend `readMetricsSummary` to return scheduler summary fields: `lastTick`, `lastDispatch`, `lastDrift`, `dispatchCounts` (totals by outcome), `lateRunCount`, `missedRunCount`, `enabledCount`, `disabledCount`.

### `scheduler` capability

- `SchedulerLoop` records a `scheduler_tick` event per session at the end of each tick that has due schedules for that session, with `dueCount` for the session and wall-clock `tickDurationMs`.
- `SchedulerLoop.processOne` records a `scheduler_dispatch` event and the appropriate outcome counter for every due schedule it touches.
- `SchedulerLoop.processOne` records `scheduler_drift` (driftMs) for every dispatched schedule by comparing the actual dispatch ISO timestamp to the schedule's `nextRunAt` before `claimDue` advanced it.
- `SchedulerLoop.processOne` records `scheduler_missed_run` when the current tick time is materially past the scheduled `nextRunAt` and `claimDue` advances a recurring schedule past one or more missed occurrences (i.e., the `while (nextMs <= nowMs) nextMs += interval` loop executes more than once). One-shot schedules are never recorded as `scheduler_missed_run`; a one-shot dispatched late is recorded as `scheduler_drift` with positive `driftMs` and increments `scheduler_late_run_total`.
- `ScheduleStore` records `schedule_enabled`/`schedule_disabled` events when a schedule transitions into `enabled` or out of `enabled` (excluding terminal `completed` for one-shots, which emits `schedule_disabled` with `trigger: "system"` and `outcome` omitted because the schedule is complete, not paused).
- `ScheduleStore` increments `scheduler_schedule_enabled_total` and `scheduler_schedule_disabled_total` at the same transitions.
- `ScheduleStore` accepts an optional `MetricsStore` singleton. If `metricsStore` is present, store lifecycle and loop dispatch events are recorded via `metricsStore.forSession(sessionId)`; if absent, the scheduler behaves exactly as before.

### `commands` capability

- `/debug` (`src/diagnostics.ts`) reads the session's `metrics.jsonl` and includes a scheduler section when the metrics module's `readMetricsSummary` exposes scheduler fields.
- The scheduler section shows, when metrics are available:
  - `Scheduler ticks: <n>` and `Last tick: <ISO>` (from `scheduler_tick` event).
  - `Dispatches: <n> (ok: <n>, error: <n>, binding-mismatch: <n>, archived: <n>)`.
  - `Late runs: <n>` and `Missed runs: <n>`.
  - `Last drift: <driftMs>ms` (`driftMs` from `scheduler_drift`).
  - `Schedules enabled: <n>, disabled: <n>`.
- The `/debug` output remains instant-timing and human-readable; metrics are read from disk, not from the live scheduler.

## Non-Goals

- No new scheduler command, `/schedule metrics` subcommand, or per-schedule UI in this change.
- No Prometheus/OTel exporter, no real-time streaming, no alerting, no cross-session dashboard.
- No guaranteed exact-time execution fix; the scheduler still polls on `tickIntervalMs`.
- No persistence format change beyond `metrics.jsonl`.
- No changes to `session-metrics` itself (the existing `metrics` module is extended by the new capability, not rewritten).
- No scheduler metrics for subagent turns or Telegram layer (those are separate follow-ups).

## Scope Note

This change is a vertical slice: the scheduler emits metrics, the metrics module can summarize them, and `/debug` displays them. It is intentionally kept as one change because the instrumentation and the debug surface are coupled by the same event schema.

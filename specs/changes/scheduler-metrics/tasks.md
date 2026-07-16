# scheduler-metrics tasks

Invariants every phase must preserve (from the proposal/specs):
- Scheduler events/counters are optional: when `metricsStore` is absent, the scheduler and store behave identically to the pre-metrics implementation.
- Metrics write failures are logged and never abort a dispatch or store mutation.
- `trigger` is recorded correctly: `command` for `/schedule`, `agent_tool` for `schedule_turn`, `scheduler` for stale-binding disable, `system` for automatic completion/broken-recurring disable.
- `/debug` remains instant-timing and human-readable.

## Phase 1: Extend metrics module for scheduler events and summary

- [ ] Add scheduler `event` names (`scheduler_tick`, `scheduler_dispatch`, `scheduler_drift`, `scheduler_missed_run`, `schedule_enabled`, `schedule_disabled`) and `counter` names to the `MetricsEvent` schema in `src/metrics/store.ts` (base module introduced by `session-metrics`). Satisfies *MetricsEvent union supports scheduler event names*.
- [ ] Extend `MetricsSummary` and `readMetricsSummary` in `src/metrics/store.ts` to parse scheduler events/counters and return a `scheduler` field. Satisfies *readMetricsSummary includes scheduler summary fields*.
- [ ] Add tests for `readMetricsSummary` scheduler parsing: populated metrics file, missing file, no scheduler events. Satisfies scenarios under *readMetricsSummary includes scheduler summary fields*.
- [ ] Run `bun test src/metrics` and `bun run typecheck`.

## Phase 2: Instrument ScheduleStore lifecycle events

- [ ] Add optional `metricsStore?: MetricsStore` to `ScheduleStore` constructor in `src/scheduler/store.ts`. All lifecycle events are emitted via `metricsStore.forSession(sessionId)`.
- [ ] Emit `schedule_enabled` and increment `scheduler_schedule_enabled_total` when `create`, `setHeartbeat`, `resume`, or `setState` transitions a schedule to `enabled`. Derive `trigger` from `source`/`agent` flags. Satisfies *Schedule store records enable and disable events* and *Schedule store increments enable and disable counters*.
- [ ] Emit `schedule_disabled` and increment `scheduler_schedule_disabled_total` when `pause`, `remove`, `claimDue` (one-shot completion or broken recurring), `recordRun` (binding-mismatch/archived), or `setState` transitions a schedule out of `enabled`. `remove` only emits if the record was `enabled` before deletion. Satisfies *Schedule store records enable and disable events* and *Schedule store increments enable and disable counters*.
- [ ] Extend `src/scheduler/store.test.ts` with lifecycle event/counter tests. Run `bun test src/scheduler/store.test.ts` and `bun run typecheck`.

## Phase 3: Instrument SchedulerLoop dispatch, drift, missed runs, and tick

- [ ] Add optional `metricsStore?: MetricsStore` to `SchedulerOptions` in `src/scheduler/loop.ts`.
- [ ] Record `scheduler_tick` at the end of `tick()` for each session that had at least one due schedule, with `tickAt`, `dueCount` for that session, and total `tickDurationMs`. Increment `scheduler_tick_total`. Satisfies *Scheduler loop records a tick event per session with due schedules*.
- [ ] In `processOne()`, capture `nextRunAt` before `claimDue`, record `scheduler_dispatch` with `outcome`, `scheduleId`, `kind`, `source`, and `errorMessage` when applicable. Increment `scheduler_dispatch_total` and `scheduler_dispatch_<outcome>_total`. Satisfies *Scheduler loop records a dispatch event for every due schedule* and *Scheduler loop increments dispatch outcome counters*.
- [ ] Record `scheduler_drift` with `driftMs` for every dispatched schedule. Increment `scheduler_late_run_total` when `driftMs > 0`. Satisfies *Scheduler loop records recurrence drift* and *Scheduler loop records late runs*.
- [ ] Detect and record `scheduler_missed_run` events when `claimDue` advances past more than one recurring occurrence. Increment `scheduler_missed_run_total`. Satisfies *Scheduler loop records missed recurring runs*.
- [ ] Extend `src/scheduler/loop.test.ts` with tick, dispatch, drift, missed-run, and optional-store tests. Run `bun test src/scheduler/loop.test.ts` and `bun run typecheck`.

## Phase 4: Wire metrics store and extend /debug

- [ ] Construct `MetricsStore` singleton in `src/bot.ts` (per `session-metrics` composition) and pass it to `new ScheduleStore(...)`. Return `metricsStore` from `buildBot` so `src/index.ts` can pass it to `SchedulerLoop`.
- [ ] Update `src/index.ts` to pass `metricsStore` into `new SchedulerLoop({ ..., metricsStore })`.
- [ ] Update `src/diagnostics.ts` to render a scheduler section in `formatDiagnostics`: tick count, last tick, dispatch breakdown, late runs, missed runs, last drift, enabled/disabled counts. Render `Scheduler metrics: unavailable` when `metrics` or `metrics.scheduler` is null. Satisfies *Debug command dumps diagnostics*.
- [ ] Extend `src/diagnostics.test.ts` with scheduler section formatting tests. Satisfies scenarios under *Debug command dumps diagnostics*.
- [ ] Run the full test suite: `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Re-read each delta spec alongside the design and code to confirm every requirement and scenario is satisfied; flag any gap.

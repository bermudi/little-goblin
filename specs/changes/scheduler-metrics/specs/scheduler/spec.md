# scheduler

## ADDED Requirements

### Requirement: Scheduler loop records a tick event per session with due schedules

`SchedulerLoop.tick()` SHALL record a `scheduler_tick` event to the session metrics store for each session that had at least one due schedule in the tick. The event SHALL include `tickAt` (ISO-8601 timestamp of the tick start), `dueCount` (number of due schedules for that session), and `tickDurationMs` (wall-clock time from the start of the tick to the end of dispatch). If the tick has no due schedules, no `scheduler_tick` event is recorded. The scheduler loop has no single owning session, so process-wide tick events are not recorded.

#### Scenario: Tick with two due schedules for one session

- **WHEN** `SchedulerLoop.tick()` is run and `listDue` returns two schedules for the same session
- **THEN** one `scheduler_tick` event SHALL be appended to that session's `metrics.jsonl` with `dueCount: 2`
- **AND** `tickDurationMs` SHALL be a non-negative number

#### Scenario: Tick with no due schedules

- **WHEN** `SchedulerLoop.tick()` is run and `listDue` returns an empty array
- **THEN** no `scheduler_tick` event SHALL be recorded

### Requirement: Scheduler loop records a dispatch event for every due schedule

`SchedulerLoop.processOne()` SHALL record a `scheduler_dispatch` event to the metrics store for the session that owns the schedule, with `scheduleId`, `kind` (`once`/`recurring`/`heartbeat`), `source` (`user`/`agent`), and `outcome` (`ok`/`binding-mismatch`/`archived`/`error`). When `outcome` is `error`, the event SHALL include `errorMessage`.

#### Scenario: Dispatch succeeds

- **WHEN** `processOne()` dispatches a valid schedule
- **THEN** a `scheduler_dispatch` event SHALL be recorded with `outcome: "ok"`

#### Scenario: Binding mismatch disables a schedule

- **WHEN** `processOne()` finds no live binding for the schedule
- **THEN** a `scheduler_dispatch` event SHALL be recorded with `outcome: "binding-mismatch"`

#### Scenario: Archived session disables a schedule

- **WHEN** `processOne()` finds that the captured session is archived
- **THEN** a `scheduler_dispatch` event SHALL be recorded with `outcome: "archived"`

#### Scenario: Dispatch error callback fires

- **WHEN** a dispatched schedule fails asynchronously and the dispatcher calls `onError`
- **THEN** a `scheduler_dispatch` event SHALL be recorded with `outcome: "error"` and the error message

### Requirement: Scheduler loop increments dispatch outcome counters

`SchedulerLoop.processOne()` SHALL increment `scheduler_dispatch_total` and the per-outcome counter `scheduler_dispatch_<outcome>_total` for each dispatch it records, where `<outcome>` is the recorded outcome string. The counters are cumulative values per session.

#### Scenario: Two successful dispatches and one error

- **WHEN** a tick processes three schedules and outcomes are `ok`, `ok`, and `error`
- **THEN** `scheduler_dispatch_total` SHALL be `3`
- **AND** `scheduler_dispatch_ok_total` SHALL be `2`
- **AND** `scheduler_dispatch_error_total` SHALL be `1`

### Requirement: Scheduler loop records recurrence drift

For every dispatched schedule, `SchedulerLoop.processOne()` SHALL capture the scheduled `nextRunAt` before `claimDue` advances it and compute `driftMs` as the difference between the actual dispatch ISO timestamp and the scheduled `nextRunAt` in milliseconds. It SHALL record a `scheduler_drift` event with `scheduleId`, `kind`, `source`, and `driftMs`. Positive `driftMs` means the dispatch occurred later than the scheduled time.

#### Scenario: Recurring schedule is dispatched exactly on time

- **WHEN** a recurring schedule is dispatched at the scheduled `nextRunAt`
- **THEN** a `scheduler_drift` event SHALL be recorded with `driftMs: 0` or a small positive value bounded by the tick interval

#### Scenario: Delayed tick causes drift

- **WHEN** a tick is delayed by 45 seconds and a recurring schedule is then dispatched
- **THEN** a `scheduler_drift` event SHALL be recorded with `driftMs` approximately 45000

### Requirement: Scheduler loop records missed recurring runs

When `claimDue` advances a recurring schedule past more than one scheduled occurrence (i.e., the `while (nextMs <= nowMs) nextMs += interval` loop executes more than once), `SchedulerLoop.processOne()` SHALL record a `scheduler_missed_run` event with `scheduleId`, `kind`, `source`, `scheduledRunAt` (the `nextRunAt` that was skipped), and `missedByMs` (the difference between `nowMs` and the skipped `nextRunAt` in milliseconds). It SHALL also increment `scheduler_missed_run_total`.

#### Scenario: Recurring schedule skipped two occurrences

- **WHEN** a 30-minute recurring schedule is not ticked for 70 minutes and the next tick advances past two missed occurrences
- **THEN** two `scheduler_missed_run` events SHALL be recorded, one per skipped occurrence
- **AND** `scheduler_missed_run_total` SHALL be `2`

### Requirement: Scheduler loop records late runs

When a schedule is dispatched and `driftMs > 0`, `SchedulerLoop.processOne()` SHALL increment `scheduler_late_run_total` for that session. This counter counts dispatches that occurred strictly after the scheduled `nextRunAt`, including both recurring and one-shot schedules.

#### Scenario: One-shot scheduled turn is late

- **WHEN** a one-shot schedule is dispatched 10 seconds after its scheduled time
- **THEN** a `scheduler_drift` event SHALL be recorded with `driftMs: 10000`
- **AND** `scheduler_late_run_total` SHALL be `1`

### Requirement: Schedule store records enable and disable events

`ScheduleStore` SHALL record `schedule_enabled` and `schedule_disabled` events to the session metrics store when a schedule transitions into or out of the `enabled` state. The event SHALL include `scheduleId`, `kind`, `source`, and `trigger` (`command`/`agent_tool`/`scheduler`/`system`). A one-shot schedule that completes SHALL emit `schedule_disabled` with `trigger: "system"` and `state: "completed"`.

#### Scenario: User enables heartbeat via command

- **WHEN** `/schedule heartbeat on` is called
- **THEN** a `schedule_enabled` event SHALL be recorded with `trigger: "command"`

#### Scenario: Agent tool pauses a schedule

- **WHEN** `schedule_turn` action `pause` is executed
- **THEN** a `schedule_disabled` event SHALL be recorded with `trigger: "agent_tool"`

#### Scenario: One-shot schedule completes

- **WHEN** a one-shot schedule is dispatched and `claimDue` marks it completed
- **THEN** a `schedule_disabled` event SHALL be recorded with `trigger: "system"` and `state: "completed"`

### Requirement: Schedule store increments enable and disable counters

`ScheduleStore` SHALL increment `scheduler_schedule_enabled_total` when a schedule transitions to `enabled` and `scheduler_schedule_disabled_total` when a schedule transitions out of `enabled` (including the terminal `completed` state). The counters are cumulative per session.

#### Scenario: Enable then disable

- **WHEN** a schedule is created enabled and later paused
- **THEN** `scheduler_schedule_enabled_total` SHALL be `1` and `scheduler_schedule_disabled_total` SHALL be `1`

### Requirement: Scheduler metrics are optional and degrade gracefully

The scheduler loop and store SHALL accept an optional `MetricsStore` singleton. When `metricsStore` is absent, no metrics events are recorded and the scheduler MUST behave identically to the pre-metrics implementation. When present, the scheduler SHALL use `metricsStore.forSession(sessionId)` to obtain a per-session store and call `record`/`incrementCounter` on it. Metrics-write failures MUST be logged and MUST NOT throw.

#### Scenario: Metrics store not wired

- **WHEN** `SchedulerLoop` is constructed without a `metricsStore`
- **THEN** `tick()` and `processOne()` SHALL run without recording metrics and without throwing

#### Scenario: Metrics write fails

- **WHEN** a metrics write throws while the scheduler is processing a due schedule
- **THEN** the error SHALL be logged and the scheduler SHALL continue to dispatch the turn

# Design: scheduler-metrics

## Architecture

This change extends the `metrics` module introduced by `session-metrics` with a scheduler-specific schema and wires the scheduler to emit it. The scheduler is process-wide, but metrics are per-session `metrics.jsonl` files, so the instrumentation is session-scoped.

```
buildBot()
   │
   ├─ creates MetricsStore singleton (session-metrics)
   │
   ├─ creates ScheduleStore(metricsStore)
   │
   └─ returns metricsStore

index.ts
   │
   └─ creates SchedulerLoop({ ..., store: scheduleStore, metricsStore })

SchedulerLoop.tick()
   │
   ├─ process each due schedule
   │  ├─ capture scheduled nextRunAt before claimDue
   │  ├─ record scheduler_dispatch, scheduler_drift, outcome counters
   │  ├─ detect missed runs from claimDue skip-loop
   │  └─ record scheduler_missed_run when advanced past >1 occurrence
   │
   └─ record scheduler_tick per session with due schedules

ScheduleStore
   │
   ├─ create / setHeartbeat / resume → schedule_enabled + counter
   ├─ pause / remove / recordRun / claimDue → schedule_disabled + counter
   └─ all writes through metricsStore.forSession(sessionId)

gatherDiagnostics()
   │
   └─ readMetricsSummary(goblinHome, sessionId) → formatDiagnostics
```

The `metrics` module already persists `MetricsEvent` records to `state/sessions/<id>/metrics.jsonl` and exposes `incrementCounter` and `readMetricsSummary`. This change adds the scheduler event/counter names and extends the summary object. The scheduler loop and store receive an optional `MetricsStore` singleton; when absent, they behave exactly as before.

### Data model

`MetricsEvent` is an existing union (per `session-metrics`). The new `event` and `counter` names are purely schema additions — the storage format is unchanged. `readMetricsSummary` returns a `MetricsSummary` object; this change adds a `scheduler` field with tick, dispatch, drift, late, missed, and lifecycle counters.

### State management

No new persistent files. All scheduler metrics are appended to the same per-session `metrics.jsonl` as turn and memory metrics. The scheduler emits events on the same code paths that already mutate `schedules.json` or dispatch turns, so the metrics stream is consistent with the actual state.

## Decisions

### Decision: Metrics are per-session, not process-wide

**Chosen.** Every scheduler event and counter is recorded to the `metrics.jsonl` of the session that owns the schedule. The `SchedulerLoop` and `ScheduleStore` are injected with a `MetricsStore` singleton and call `metricsStore.forSession(sessionId)` for each write.

**Why.** The `metrics` module already partitions `metrics.jsonl` by session. Introducing a separate process-wide metrics file would duplicate the `MetricsStore` implementation and complicate `/debug` (which is session-scoped). Session ownership is the natural boundary for scheduler observability because schedules are owned by sessions and `/debug` is per-session.

**Constraints.** The `SchedulerLoop` is process-wide, but a `scheduler_tick` event is not global. It is recorded per session that had at least one due schedule in the tick, with `tickDurationMs` being the total tick duration and `dueCount` being the count for that session. Idle ticks with no due schedules produce no events. This is acceptable because the scheduler summary is only meaningful for sessions that have schedules.

### Decision: `trigger` is derived from existing caller flags, not a new method parameter

**Chosen.** The `schedule_enabled`/`schedule_disabled` event `trigger` field is inferred from the caller:
- `/schedule` command path → `trigger: "command"`
- `schedule_turn` agent tool → `trigger: "agent_tool"` (from `source === "agent"` or `agent === true`)
- `SchedulerLoop` disabling a stale binding → `trigger: "scheduler"`
- `claimDue` completing a one-shot or disabling a broken recurring record → `trigger: "system"`

**Why.** The store already has `source` on `create` and `agent` boolean on `pause`/`resume`/`remove`/`setHeartbeat`. Adding a new `trigger` parameter to every public method would churn the command and tool tests without adding new information. The mapping is one-to-one today.

**Alternative considered:** Add explicit `trigger` parameter to `create`, `setHeartbeat`, `pause`, `resume`, `remove`. Rejected to keep the change surface small and avoid modifying `schedule_turn` tool and `/schedule` command signatures. If future callers need a different trigger, the parameter can be added then.

### Decision: `scheduler_drift` is captured before `claimDue` advances `nextRunAt`

**Chosen.** `processOne` reads the `nextRunAt` of the due schedule before calling `store.claimDue()`. The `driftMs` is `dispatchTimestampMs - scheduledNextRunAtMs`.

**Why.** After `claimDue`, the recurring `nextRunAt` is already advanced, so the original scheduled time is lost. Capturing before claim gives the actual delay of *this* occurrence. For one-shot schedules, `driftMs` is the lateness of the single run.

**Constraints.** `driftMs` can be negative if the scheduler dispatches slightly before the scheduled time due to clock rounding or `listDue` using `<=`. Negative values are recorded as-is and indicate early dispatch.

### Decision: `scheduler_missed_run` is recorded when `claimDue` advances past more than one occurrence

**Chosen.** `SchedulerLoop.processOne` captures the scheduled `nextRunAt` before `claimDue` and the wall-clock `nowMs` at dispatch. For recurring schedules, it computes the number of skipped occurrences as `Math.max(0, Math.floor((nowMs - scheduledNextRunAtMs) / intervalMs))`. If the result is greater than zero, it records one `scheduler_missed_run` event per skipped occurrence, with `scheduledRunAt` set to each skipped `nextRunAt` and `missedByMs` computed from `nowMs`.

**Why.** `ScheduleStore.claimDue` already advances `nextRunAt` to the next future occurrence, but it does not return how many occurrences were skipped. Computing it in the loop from the captured `nextRunAt` and `nowMs` avoids changing `claimDue`'s return signature and keeps store logic focused on persistence. One-shot schedules cannot be missed in the same way because they have a single occurrence; a one-shot dispatched late is recorded as a late `driftMs`, not a missed run.

**Constraints.** `scheduler_missed_run` is only recorded when the scheduler is actually running and sees the overrun. If the process is stopped for a long time, the first tick after restart will see and record all skipped occurrences. The computation assumes the interval did not change between occurrences.

### Decision: Metrics are optional and degrade gracefully

**Chosen.** The `SchedulerLoop` constructor and `ScheduleStore` constructor accept an optional `metricsStore`. When `metricsStore` is undefined, all metrics calls are no-ops and the scheduler/store behavior is unchanged.

**Why.** The `metrics` module is new in `session-metrics`; tests and subagents that do not construct a `MetricsStore` should not break. The scheduler should never abort a dispatch or a store mutation because a metrics write failed.

**Implementation.** `SchedulerLoop` catches and logs metrics errors inside `processOne` and `tick()` so a bad `metrics.jsonl` does not stop the scheduler. `ScheduleStore` wraps metrics calls in a try-catch and logs warnings.

### Decision: `readMetricsSummary` is extended, not duplicated

**Chosen.** The scheduler summary is computed from the same `metrics.jsonl` parse pass that already returns turn/memory summaries. The `MetricsSummary` object gains a `scheduler` field.

**Why.** A separate summary function would re-read the file and double I/O. A single parse keeps the `metrics` module simple and ensures `/debug` sees a consistent snapshot.

### Decision: `/debug` renders scheduler metrics as a human-readable section

**Chosen.** `formatDiagnostics` adds a scheduler section after the existing session metrics section (from `session-metrics`). It reads `metrics.scheduler` from the `MetricsSummary` and renders tick count, dispatch breakdown, late/missed runs, last drift, and enabled/disabled counts.

**Why.** `/debug` is the existing diagnostics surface and is instant-timing. No new command is needed. The scheduler section is a natural extension of the metrics section.

## File Changes

### Modified

- **`src/scheduler/loop.ts`** — `SchedulerOptions` gains an optional `metricsStore?: MetricsStore`. `tick()` groups due schedules by session, records a `scheduler_tick` event per session with `tickAt`, `dueCount`, and `tickDurationMs`, and increments `scheduler_tick_total`. `processOne()` captures the scheduled `nextRunAt` before `claimDue`, records `scheduler_dispatch` events and per-outcome counters, records `scheduler_drift` with `driftMs`, and records `scheduler_missed_run` events when `claimDue` advances past multiple occurrences. All metrics calls are guarded and logged, never thrown. Satisfies: *Scheduler loop records tick event per session with due schedules*, *Scheduler loop records dispatch events*, *Scheduler loop increments dispatch counters*, *Scheduler loop records recurrence drift*, *Scheduler loop records missed recurring runs*, *Scheduler loop records late runs*, *Scheduler metrics are optional and degrade gracefully*.

- **`src/scheduler/store.ts`** — `ScheduleStore` constructor gains an optional `metricsStore?: MetricsStore`. `create`, `setHeartbeat`, `resume`, `setState` record `schedule_enabled` and increment `scheduler_schedule_enabled_total` when a schedule transitions to `enabled`. `pause`, `remove`, `claimDue` (one-shot completion / broken recurring), and `recordRun` (binding-mismatch/archived) record `schedule_disabled` and increment `scheduler_schedule_disabled_total` when a schedule transitions out of `enabled`. `trigger` is derived from `source`/`agent` flags. `remove` only records a disable event when the removed schedule was `enabled`. Satisfies: *Schedule store records enable and disable events*, *Schedule store increments enable and disable counters*.

- **`src/metrics/store.ts`** (base introduced by `session-metrics`) — Extend the `MetricsEvent` union to accept the scheduler event names. Extend `readMetricsSummary` to parse `scheduler_tick`, `scheduler_dispatch`, `scheduler_drift`, `scheduler_missed_run`, `schedule_enabled`, `schedule_disabled`, and the scheduler counters, and return a `MetricsSummary` with a `scheduler` field. Satisfies: *MetricsEvent union supports scheduler event names*, *readMetricsSummary includes scheduler summary fields*.

- **`src/diagnostics.ts`** — `gatherDiagnostics` already adds `metrics: MetricsSummary | null` per `session-metrics`; ensure it calls `readMetricsSummary` if not already present. `formatDiagnostics` renders a new scheduler section: `Scheduler ticks`, `Last tick`, `Dispatches`, `Late runs`, `Missed runs`, `Last drift`, `Schedules enabled`, `Schedules disabled`. When `metrics` or `metrics.scheduler` is null, render `Scheduler metrics: unavailable`. Satisfies the modified *Debug command dumps diagnostics* requirement.

- **`src/bot.ts`** — Construct a `MetricsStore` singleton (per `session-metrics`) and pass it to `new ScheduleStore(cfg.goblinHome, makeScheduleId, metricsStore)`. Return `metricsStore` in the `buildBot` result so `src/index.ts` can pass it to the scheduler. Satisfies the wiring for scheduler instrumentation.

- **`src/index.ts`** — Pass `metricsStore` from `buildBot` into `new SchedulerLoop({ ..., metricsStore })`. Satisfies the wiring for scheduler instrumentation.

### Tests (updated or created)

- **`src/scheduler/loop.test.ts`** — Add tests for tick event with dueCount, dispatch event and outcome counters, drift event, missed-run event when `claimDue` skips multiple occurrences, and graceful behavior when `metricsStore` is absent or throws.
- **`src/scheduler/store.test.ts`** — Add tests for `schedule_enabled`/`schedule_disabled` events and counters on create, pause, resume, remove, heartbeat, and `claimDue` completion.
- **`src/diagnostics.test.ts`** — Add tests for scheduler section formatting when `metrics.scheduler` is present and when it is null.

### Not changed (and why)

- **`src/scheduler/types.ts`** — No schema changes needed. The `trigger` field is part of the `MetricsEvent` `extra` payload, not a new `ScheduledTurn` field.
- **`src/scheduler/tool.ts`** — No changes. `trigger` is derived from `source === "agent"` and the existing `agent` boolean passed to `pause`/`resume`/`remove`.
- **`src/commands/schedule.ts`** — No changes. The `/schedule` command path naturally maps to `trigger: "command"`.
- **`src/commands/registry.ts`** — No changes. `generateDiagnostics` already receives `goblinHome` and `session`; the scheduler section is rendered inside `formatDiagnostics`.

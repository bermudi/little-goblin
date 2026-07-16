# metrics

## ADDED Requirements

### Requirement: MetricsEvent union supports scheduler event names

The `metrics` module's `MetricsEvent` union SHALL support scheduler-scoped `event` names as well as `counter` names. The scheduler events and counters are recorded through the existing `record` and `incrementCounter` APIs; the module SHALL persist them to `metrics.jsonl` with the same JSONL semantics as turn, counter, and memory events.

`event` names used by the scheduler capability SHALL be:
- `scheduler_tick` — `tickAt` (ISO-8601 string), `dueCount` (number), `tickDurationMs` (number).
- `scheduler_dispatch` — `scheduleId` (string), `kind` (`"once"` | `"recurring"` | `"heartbeat"`), `source` (`"user"` | `"agent"`), `outcome` (`"ok"` | `"binding-mismatch"` | `"archived"` | `"error"`), `errorMessage` (string | null).
- `scheduler_drift` — `scheduleId` (string), `kind` (`"once"` | `"recurring"` | `"heartbeat"`), `source` (`"user"` | `"agent"`), `driftMs` (number).
- `scheduler_missed_run` — `scheduleId` (string), `kind` (`"once"` | `"recurring"` | `"heartbeat"`), `source` (`"user"` | `"agent"`), `scheduledRunAt` (string), `missedByMs` (number).
- `schedule_enabled` — `scheduleId` (string), `kind` (string), `source` (`"user"` | `"agent"`), `trigger` (`"command"` | `"agent_tool"` | `"scheduler"` | `"system"`).
- `schedule_disabled` — `scheduleId` (string), `kind` (string), `source` (`"user"` | `"agent"`), `trigger` (`"command"` | `"agent_tool"` | `"scheduler"` | `"system"`), `state` (`"disabled"` | `"completed"` | null).

`counter` names used by the scheduler capability SHALL be:
- `scheduler_dispatch_total`
- `scheduler_dispatch_ok_total`
- `scheduler_dispatch_error_total`
- `scheduler_dispatch_binding_mismatch_total`
- `scheduler_dispatch_archived_total`
- `scheduler_tick_total`
- `scheduler_late_run_total`
- `scheduler_missed_run_total`
- `scheduler_schedule_enabled_total`
- `scheduler_schedule_disabled_total`

#### Scenario: Record a scheduler tick event

- **WHEN** `record({ type: "event", name: "scheduler_tick", scope: null, extra: { tickAt: "2026-07-16T00:00:00.000Z", dueCount: 0, tickDurationMs: 12 } })` is called
- **THEN** the persisted JSONL line SHALL contain `name: "scheduler_tick"`, `extra.tickAt: "2026-07-16T00:00:00.000Z"`, and `extra.dueCount: 0`

#### Scenario: Record a scheduler dispatch event

- **WHEN** `record({ type: "event", name: "scheduler_dispatch", scope: null, extra: { scheduleId: "abc", kind: "recurring", source: "agent", outcome: "ok" } })` is called
- **THEN** the persisted JSONL line SHALL contain `outcome: "ok"` and `scheduleId: "abc"`

#### Scenario: Increment scheduler dispatch counters

- **WHEN** `incrementCounter("scheduler_dispatch_ok_total", null)` is called twice
- **THEN** the first line SHALL contain `value: 1`
- **AND** the second line SHALL contain `value: 2`

### Requirement: readMetricsSummary includes scheduler summary fields

The `metrics` module's `readMetricsSummary` function SHALL parse scheduler events and counters from `metrics.jsonl` and return a `MetricsSummary` object that includes a `scheduler` field. The `scheduler` field SHALL contain at least:
- `tickCount` — the number of `scheduler_tick` events.
- `lastTick` — the `scheduler_tick` event with the latest `tickAt` (or the last one in file order if `tickAt` is missing), or `null`.
- `dispatchCount` — the total `scheduler_dispatch_total` counter value.
- `dispatchByOutcome` — an object mapping each outcome (`ok`, `error`, `binding-mismatch`, `archived`) to the last recorded `scheduler_dispatch_<outcome>_total` counter value.
- `lastDispatch` — the last `scheduler_dispatch` event, or `null`.
- `lastDrift` — the last `scheduler_drift` event, or `null`.
- `lateRunCount` — the last `scheduler_late_run_total` counter value.
- `missedRunCount` — the last `scheduler_missed_run_total` counter value.
- `enabledCount` — the last `scheduler_schedule_enabled_total` counter value.
- `disabledCount` — the last `scheduler_schedule_disabled_total` counter value.

When `metrics.jsonl` is missing or empty, the `scheduler` field SHALL be `null` or omitted and the function SHALL return `null` for the entire summary as specified in the base `metrics` capability.

#### Scenario: Summary with one tick, one dispatch, and one drift

- **WHEN** `readMetricsSummary(home, sessionId)` is called and `metrics.jsonl` contains one `scheduler_tick`, one `scheduler_dispatch`, one `scheduler_drift`, and one `scheduler_dispatch_ok_total` counter
- **THEN** `summary.scheduler.tickCount` SHALL be `1`
- **AND** `summary.scheduler.dispatchCount` SHALL be `1`
- **AND** `summary.scheduler.dispatchByOutcome.ok` SHALL be `1`
- **AND** `summary.scheduler.lastDrift.driftMs` SHALL equal the event's `driftMs`

#### Scenario: Missing metrics file

- **WHEN** `readMetricsSummary(home, sessionId)` is called and `metrics.jsonl` does not exist
- **THEN** it SHALL return `null` (or throw `ENOENT` mapped to `null`) as in the base `metrics` capability

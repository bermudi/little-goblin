# commands

## MODIFIED Requirements

### Requirement: Debug command dumps diagnostics

The `/debug` command is instant-timing: it runs immediately regardless of streaming state and does not abort or defer the current turn. It SHALL include the session name in its diagnostics output. `gatherDiagnostics` SHALL extract `deps.session.title ?? null` into a `sessionName` field on the `Diagnostics` type. `formatDiagnostics` SHALL render `Session Name: <name>` immediately after `Session: <id>` when the name is present, and `Session Name: unavailable` when absent.

`/debug` SHALL read the session's `metrics.jsonl` via the `metrics` module's `readMetricsSummary` helper and include the metrics that are available. The existing metrics section (per the `session-metrics` change) includes last turn, session totals, memory counters, and cache summary. This change extends the metrics section to include scheduler metrics:

- `Scheduler ticks: <n>` and, when present, `Last tick: <ISO>` and `Last tick duration: <n>ms`.
- `Dispatches: <total> (ok: <ok>, error: <error>, binding-mismatch: <mismatch>, archived: <archived>)`.
- `Late runs: <n>`.
- `Missed runs: <n>`.
- `Last drift: <driftMs>ms` (when `scheduler.lastDrift` is present).
- `Schedules enabled: <n>, disabled: <n>`.

`gatherDiagnostics` SHALL add `metrics: MetricsSummary | null` to the `Diagnostics` type (as already added by `session-metrics`) and `formatDiagnostics` SHALL render the scheduler fields above when `metrics.scheduler` is non-null. When `metrics` is null or `metrics.scheduler` is null, the scheduler section SHALL render `Scheduler metrics: unavailable`.

#### Scenario: Named session with scheduler metrics

- **WHEN** `/debug` is invoked on a session with `title: "ttt-v2"` and `metrics.jsonl` contains one `scheduler_tick`, one successful `scheduler_dispatch`, one `scheduler_drift` with `driftMs: 1500`, and the corresponding counters
- **THEN** the output SHALL contain `Session: <id>` followed by `Session Name: ttt-v2`
- **AND** it SHALL contain `Scheduler ticks: 1` and `Last tick: <ISO>`
- **AND** it SHALL contain `Dispatches: 1 (ok: 1, error: 0, binding-mismatch: 0, archived: 0)`
- **AND** it SHALL contain `Last drift: 1500ms`

#### Scenario: Session with missing metrics file

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` is missing
- **THEN** the output SHALL contain `Scheduler metrics: unavailable`

#### Scenario: Session with metrics but no scheduler events

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` contains only `session-metrics` data and no scheduler events
- **THEN** the output SHALL contain `Scheduler metrics: unavailable`
- **AND** the existing session metrics section (turns, memory, cache) SHALL still render

#### Scenario: Unnamed session with scheduler metrics

- **WHEN** `/debug` is invoked on a session without a `title` and `metrics.jsonl` contains scheduler events
- **THEN** the output SHALL contain `Session Name: unavailable`
- **AND** the scheduler section SHALL still render if scheduler metrics are present

# metrics

## ADDED Requirements

### Requirement: MetricsEvent types include external-agent metrics

The `MetricsEvent` union SHALL include the following types in addition to `turn`, `counter`, and `event`:

- `external_agent_run` — with `backend` (`"codex" | "claude" | "devin"`), `status` (`"completed" | "failed" | "cancelled" | "timed_out" | "interrupted"`), `durationMs` (non-negative number), `adapterKind` (`"native" | "pty"`), `startedAt` (ISO timestamp), and `endedAt` (ISO timestamp).
- `external_agent_concurrency` — with `active` (non-negative integer), `waiting` (non-negative integer), and `max` (positive integer).

`counter` events for external-agent metrics SHALL be named `external_agent_run_started_total`, `external_agent_run_completed_total`, `external_agent_run_failed_total`, `external_agent_run_cancelled_total`, `external_agent_run_timed_out_total`, `external_agent_run_interrupted_total`, and `external_agent_pty_fallback_total`, scoped by backend name.

#### Scenario: External run event recorded

- **WHEN** `record({ type: "external_agent_run", backend: "codex", status: "completed", durationMs: 12345, adapterKind: "native", startedAt: "...", endedAt: "..." })` is called
- **THEN** a single JSON line SHALL be appended with those exact fields
- **AND** the line SHALL be parseable as a `MetricsEvent`

#### Scenario: External concurrency event recorded

- **WHEN** `record({ type: "external_agent_concurrency", active: 2, waiting: 1, max: 2 })` is called
- **THEN** a single JSON line SHALL be appended with those exact fields

#### Scenario: Counter names for external-agent outcomes

- **WHEN** `incrementCounter("external_agent_run_completed_total", "codex")` is called
- **THEN** a `counter` event SHALL be appended with `name: "external_agent_run_completed_total"`, `scope: "codex"`, and a cumulative `value`

### Requirement: readMetricsSummary includes external-agent metrics

`readMetricsSummary(goblinHome, sessionId)` SHALL return a `MetricsSummary` object that includes an `externalAgent` field. The `externalAgent` summary SHALL include:

- `runsByBackend`: a record mapping each backend (`codex`, `claude`, `devin`) to the number of `external_agent_run` events recorded.
- `outcomesByBackend`: a record mapping each backend to a record of terminal counts (`completed`, `failed`, `cancelled`, `timed_out`, `interrupted`) from the last recorded counter value for each outcome counter.
- `totalRuns`: the total number of `external_agent_run` events across all backends.
- `averageDurationMs`: the arithmetic mean of `durationMs` from all `external_agent_run` events, rounded to the nearest integer.
- `averageDurationByBackend`: a record mapping each backend to its mean `durationMs`.
- `ptyFallbackByBackend`: a record mapping each backend to the last recorded `external_agent_pty_fallback_total` counter value.
- `totalPtyFallbacks`: the sum of all `external_agent_pty_fallback_total` counter values.
- `lastConcurrency`: the last `external_agent_concurrency` event, or `null` when none exists.

`readMetricsSummary` SHALL return `null` for the entire summary when `metrics.jsonl` is missing or unreadable, and the `externalAgent` field SHALL be present when the file exists.

#### Scenario: Summary with one completed run

- **WHEN** `metrics.jsonl` contains one `external_agent_run` event for `codex` with `durationMs: 10000` and one `external_agent_run_completed_total` counter
- **THEN** `externalAgent.totalRuns` SHALL equal `1`
- **AND** `externalAgent.runsByBackend.codex` SHALL equal `1`
- **AND** `externalAgent.outcomesByBackend.codex.completed` SHALL equal `1`
- **AND** `externalAgent.averageDurationMs` SHALL equal `10000`

#### Scenario: Missing metrics file

- **WHEN** `readMetricsSummary(home, sessionId)` is called and `metrics.jsonl` does not exist
- **THEN** it SHALL return `null` for the entire summary

#### Scenario: Multiple backends with mixed outcomes

- **WHEN** `metrics.jsonl` contains one completed codex run, one failed claude run, and one codex PTY fallback
- **THEN** `externalAgent.totalRuns` SHALL equal `2`
- **AND** `externalAgent.runsByBackend.codex` SHALL equal `1`
- **AND** `externalAgent.runsByBackend.claude` SHALL equal `1`
- **AND** `externalAgent.outcomesByBackend.codex.completed` SHALL equal `1`
- **AND** `externalAgent.outcomesByBackend.claude.failed` SHALL equal `1`
- **AND** `externalAgent.totalPtyFallbacks` SHALL equal `1`

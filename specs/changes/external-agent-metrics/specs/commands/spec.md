# commands

## ADDED Requirements

### Requirement: Debug command includes external-agent metrics

The `/debug` command is instant-timing and SHALL include external-agent metrics in its diagnostics output. `gatherDiagnostics` SHALL read `metrics.jsonl` via the `metrics` module's `readMetricsSummary` helper and include the `externalAgent` summary in `Diagnostics.metrics`. `formatDiagnostics` SHALL render the external-agent section with per-backend run counts, outcome breakdown, average runtime, concurrency utilization, and PTY fallback count.

The external-agent section SHALL be rendered when `metrics` is non-null and `metrics.externalAgent` is non-empty; when `metrics` is null or `externalAgent` has zero runs, the section SHALL be omitted or rendered as `External agents: none`.

#### Scenario: Debug with external-agent activity

- **WHEN** `/debug` is invoked on a session with `metrics.jsonl` containing one completed codex run and one PTY fallback
- **THEN** the output SHALL contain `External agents:`
- **AND** it SHALL contain `codex: 1 completed, 0 failed, 0 cancelled, 0 timed out, 0 interrupted`
- **AND** it SHALL contain `Avg runtime: 10.0s`
- **AND** it SHALL contain `PTY fallback: 1`

#### Scenario: Debug with no external-agent runs

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` has no `external_agent_run` events
- **THEN** the output SHALL contain `External agents: none` or omit the external-agent section

#### Scenario: Debug with missing metrics file

- **WHEN** `/debug` is invoked on a session with no `metrics.jsonl`
- **THEN** the output SHALL contain `Metrics: unavailable`
- **AND** no external-agent section SHALL be rendered

### Requirement: Diagnostics type includes external-agent metrics

The `Diagnostics` interface SHALL include an `externalAgent` field within `metrics` (or directly as `externalAgentMetrics`) that carries the external-agent summary from `readMetricsSummary`. `formatDiagnostics` SHALL destructure this field to render the external-agent section.

#### Scenario: Gather diagnostics with external-agent metrics

- **WHEN** `gatherDiagnostics` is called for a session with external-agent metrics
- **THEN** the returned `Diagnostics` object SHALL have `metrics.externalAgent` populated with `runsByBackend`, `outcomesByBackend`, `averageDurationMs`, and `totalPtyFallbacks`

#### Scenario: Format diagnostics without external-agent metrics

- **WHEN** `formatDiagnostics` is called with `metrics` present but no external-agent runs
- **THEN** the output SHALL NOT claim an unsupported external-agent state
- **AND** it SHALL render `External agents: none` if the section is present

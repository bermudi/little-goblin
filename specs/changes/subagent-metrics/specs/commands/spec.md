# commands

## MODIFIED Requirements

### Requirement: Debug command dumps diagnostics

The `/debug` command SHALL continue to be instant-timing and read-only. `gatherDiagnostics` SHALL call `readSubagentMetricsSummary(deps.goblinHome)` and add a `subagentMetrics: SubagentMetricsSummary | null` field to the `Diagnostics` type. `formatDiagnostics` SHALL render the subagent metrics section after the existing `Subagents` line, including total subagents, completed, cancelled, errors, timeouts, average spawn/revive latency, total subagent tokens, total cost, and cache read/write totals. When `subagentMetrics` is `null`, the section SHALL render `Subagent metrics: unavailable`.

#### Scenario: Debug with active subagent metrics

- **WHEN** `/debug` is invoked and `subagent-metrics.jsonl` contains `subagent_total: 2`, one `subagent_spawn` event with `latencyMs: 100`, one `subagent_turn` event with `usage.totalTokens: 150`, and one `subagent_result` event with `status: "completed"`
- **THEN** the output SHALL contain `Subagents: 2 spawned/revived, 1 completed, 0 cancelled, 0 errors, 0 timeouts` (or equivalent)
- **AND** it SHALL contain `Avg spawn latency: 100ms` (or equivalent)
- **AND** it SHALL contain `Subagent tokens: 150`, `Cost: $ ...`, and `Cache: ... read / ... write tokens`

#### Scenario: Debug with no subagent metrics file

- **WHEN** `/debug` is invoked and `subagent-metrics.jsonl` is missing
- **THEN** the output SHALL contain `Subagent metrics: unavailable`
- **AND** the existing `Subagents` line SHALL still render active and running counts from `subagentRunner.list()`

#### Scenario: Debug output still shows active subagent counts

- **WHEN** `/debug` is invoked while `subagentRunner.list()` returns two tracked subagents with one running
- **THEN** the output SHALL contain `Subagents: 2 tracked, 1 running`
- **AND** the subagent metrics section SHALL follow it

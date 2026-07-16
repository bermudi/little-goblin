# metrics

## ADDED Requirements

### Requirement: MetricsStore provides a process-level subagent store

The `MetricsStore` class SHALL expose a static `forSubagent(home: string)` factory that returns a `MetricsStore` writing to `$GOBLIN_HOME/state/subagent-metrics.jsonl`. The returned store SHALL use the same append-only JSONL `record` and `incrementCounter` semantics as `MetricsStore.forSession`.

#### Scenario: Subagent store writes to the process-level file

- **WHEN** `MetricsStore.forSubagent("/home/goblin")` is constructed and `record({ type: "counter", name: "subagent_total", value: 1 })` is called
- **THEN** a line SHALL be appended to `/home/goblin/state/subagent-metrics.jsonl`
- **AND** the file SHALL be valid JSONL

#### Scenario: Subagent store path is separate from session metrics

- **WHEN** `MetricsStore.forSubagent(home)` is constructed
- **THEN** its file path SHALL NOT be under `state/sessions/`
- **AND** its file path SHALL end with `state/subagent-metrics.jsonl`

### Requirement: Subagent metrics use stable counter and event names

`MetricsStore` for subagents SHALL write `counter` and `event` entries using the following names and `extra` fields:

- `subagent_total` counter — total spawns plus revives.
- `subagent_spawn_total` counter — total spawns.
- `subagent_revive_total` counter — total revives.
- `subagent_completed_total` counter — total completed turns.
- `subagent_cancelled_total` counter — total cancellations initiated by a caller.
- `subagent_error_total` counter — total errors that terminate the run.
- `subagent_timeout_total` counter — total timeout-triggered cancellations.
- `subagent_spawn` event — `extra` SHALL contain `latencyMs` (number) from `spawn()` call to the first `agent_start` event.
- `subagent_revive` event — `extra` SHALL contain `latencyMs` (number) from `revive()` call to the first `agent_start` event.
- `subagent_turn` event — `extra` SHALL contain `usage`, `cost`, `cacheRead`, `cacheWrite`, `model`, `provider`, `api`, `stopReason`, `errorMessage`, and `durationMs`.
- `subagent_result` event — `extra` SHALL contain `status` (`"completed"`, `"cancelled"`, `"error"`, or `"timeout"`) and `errorMessage`.

All `event` entries for a specific subagent SHALL use `scope: <subagentId>`.

#### Scenario: Spawn latency event is recorded

- **WHEN** a subagent is spawned and the run reaches `agent_start`
- **THEN** a `subagent_spawn` event with `scope` equal to the subagent id and `extra.latencyMs` SHALL be appended to `subagent-metrics.jsonl`

#### Scenario: Turn usage event is recorded

- **WHEN** a subagent assistant `message_end` arrives with `usage.totalTokens: 150`
- **THEN** a `subagent_turn` event with `scope` equal to the subagent id and `extra.usage.totalTokens: 150` SHALL be appended

#### Scenario: Outcome counters are cumulative

- **WHEN** `incrementCounter("subagent_completed_total", null)` is called three times
- **THEN** the persisted `counter` values SHALL be `1`, `2`, and `3`

### Requirement: metrics module exposes readSubagentMetricsSummary

The `metrics` module SHALL export a `readSubagentMetricsSummary(home: string)` function that scans `subagent-metrics.jsonl` and returns a `SubagentMetricsSummary` object. The summary SHALL include the last recorded values of the counters listed above, the average `latencyMs` across `subagent_spawn` and `subagent_revive` events, the sums of `usage.totalTokens`, `cost`, `cacheRead`, and `cacheWrite` across `subagent_turn` events, and a per-subagent breakdown keyed by `scope`. The function SHALL return `null` when the file is missing, and SHALL skip malformed lines.

#### Scenario: Summary from populated subagent metrics

- **WHEN** `readSubagentMetricsSummary(home)` is called and `subagent-metrics.jsonl` contains `subagent_total: 2`, one `subagent_spawn` event with `latencyMs: 100`, one `subagent_turn` event with `usage.totalTokens: 150`, and one `subagent_result` event with `status: "completed"`
- **THEN** the summary SHALL contain `totalSubagents: 2`, `avgSpawnLatencyMs: 100`, `totalTokens: 150`, `completed: 1`, and `perSubagent[id].status: "completed"`

#### Scenario: Summary for missing file

- **WHEN** `readSubagentMetricsSummary(home)` is called and `subagent-metrics.jsonl` does not exist
- **THEN** it SHALL return `null`

### Requirement: SubagentMetricsSummary reflects the latest terminal state per subagent

For each `scope`, `readSubagentMetricsSummary` SHALL use the most recent `subagent_result` event to determine the terminal `status` of that subagent. `perSubagent[id]` SHALL contain the last `subagent_turn` usage and the last `subagent_spawn` or `subagent_revive` latency if any exist.

#### Scenario: Subagent completes after an earlier timeout

- **WHEN** `subagent-metrics.jsonl` contains a `subagent_result` event with `status: "timeout"` followed by a `subagent_result` event with `status: "completed"` for the same subagent id
- **THEN** `perSubagent[id].status` SHALL be `"completed"`

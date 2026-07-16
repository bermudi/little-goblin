# subagents

## MODIFIED Requirements

### Requirement: Cancel subagent aborts execution

The `SubagentRunner.cancel()` method SHALL continue to abort the specified subagent and mark its status as `cancelled`. When it aborts a subagent whose status was `running`, it SHALL also call `MetricsStore.incrementCounter("subagent_cancelled_total", null)` and record a `subagent_result` event with `status: "cancelled"` and `scope` equal to the subagent id.

#### Scenario: Cancel running subagent increments cancelled counter

- **WHEN** `cancel("abc123")` is called on a running subagent
- **THEN** the subagent SHALL be marked `cancelled`
- **AND** `subagent_cancelled_total` SHALL be incremented in `subagent-metrics.jsonl`
- **AND** a `subagent_result` event with `scope: "abc123"` and `status: "cancelled"` SHALL be recorded

#### Scenario: Cancel terminal subagent does not double-count

- **WHEN** `cancel("abc123")` is called on a subagent that is already `completed`
- **THEN** it SHALL return without incrementing `subagent_cancelled_total`

## ADDED Requirements

### Requirement: SubagentRunner records spawn and revive latency

`SubagentRunner` SHALL construct a process-level `MetricsStore` via `MetricsStore.forSubagent(this.cfg.goblinHome)` on construction. `spawn()` and `revive()` SHALL capture a start timestamp, increment `subagent_total` and `subagent_spawn_total`/`subagent_revive_total`, and pass the store to `runInstance`. `runInstance` SHALL record a `subagent_spawn` or `subagent_revive` event with `latencyMs` (start timestamp to the first `agent_start` event) and `scope` equal to the subagent id.

#### Scenario: Spawn records spawn latency

- **WHEN** `spawn({ prompt: "..." })` is called and the subagent reaches `agent_start`
- **THEN** `subagent_total` and `subagent_spawn_total` SHALL be incremented
- **AND** a `subagent_spawn` event with `latencyMs` and `scope` equal to the new subagent id SHALL be recorded

#### Scenario: Revive records revive latency

- **WHEN** `revive("abc123", "...")` is called and the subagent reaches `agent_start`
- **THEN** `subagent_total` and `subagent_revive_total` SHALL be incremented
- **AND** a `subagent_revive` event with `latencyMs` and `scope: "abc123"` SHALL be recorded

### Requirement: SubagentRunner records token usage per subagent

`runInstance` SHALL track the `agent_start` timestamp and the assistant `message_end` usage. When `message_end` arrives, it SHALL record a `subagent_turn` event with `scope` equal to the subagent id, `durationMs` from `agent_start` to `message_end`, and `usage`, `cost`, `cacheRead`, `cacheWrite`, `model`, `provider`, `api`, `stopReason`, and `errorMessage` copied from the `message_end` message.

#### Scenario: Subagent turn records usage

- **WHEN** a subagent run emits an assistant `message_end` with `usage.totalTokens: 200` and `stopReason: "stop"`
- **THEN** a `subagent_turn` event with `scope` equal to the subagent id and `extra.usage.totalTokens: 200` SHALL be recorded

#### Scenario: Subagent turn with cache writes records cache

- **WHEN** a subagent turn emits `message_end` with `usage.cacheRead: 1000` and `usage.cacheWrite: 500`
- **THEN** the `subagent_turn` event SHALL contain `extra.cacheRead: 1000` and `extra.cacheWrite: 500`

### Requirement: SubagentRunner records completion and error outcomes

`markCompleted` SHALL increment `subagent_completed_total` and record a `subagent_result` event with `status: "completed"` and `scope` equal to the subagent id. `markErrored` SHALL increment `subagent_error_total` and record a `subagent_result` event with `status: "error"` and `errorMessage` in `extra`.

#### Scenario: Completed subagent increments completed counter

- **WHEN** a subagent reaches `agent_end`
- **THEN** `subagent_completed_total` SHALL be incremented
- **AND** a `subagent_result` event with `status: "completed"` and the subagent id as `scope` SHALL be recorded

#### Scenario: Errored subagent increments error counter

- **WHEN** a subagent run fails with an error message
- **THEN** `subagent_error_total` SHALL be incremented
- **AND** a `subagent_result` event with `status: "error"` and `extra.errorMessage` SHALL be recorded

### Requirement: SubagentRunner exposes recordTimeout for timeout metrics

`SubagentRunner` SHALL expose a `recordTimeout(id: string)` method that aborts the subagent like `cancel()` but records a timeout outcome instead of a cancellation. The `spawn_subagent` and `revive_subagent` tool handlers (`src/subagents/tool.ts`) SHALL call `runner.recordTimeout(id)` when the timeout fires, in place of `runner.cancel(id)`. `recordTimeout` SHALL mark the subagent as `cancelled`, abort its session, increment `subagent_timeout_total`, and record a `subagent_result` event with `status: "timeout"` and `scope` equal to the subagent id.

#### Scenario: Timeout records timeout counter

- **WHEN** a subagent execution exceeds the tool timeout and `recordTimeout("abc123")` is called
- **THEN** the subagent SHALL be marked `cancelled`
- **AND** `subagent_timeout_total` SHALL be incremented
- **AND** a `subagent_result` event with `status: "timeout"` and `scope: "abc123"` SHALL be recorded

#### Scenario: Timeout does not count as a user cancellation

- **WHEN** a timeout fires and `recordTimeout` is called
- **THEN** `subagent_cancelled_total` SHALL NOT be incremented
- **AND** `subagent_timeout_total` SHALL be incremented

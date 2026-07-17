# agent

## ADDED Requirements

### Requirement: AgentRunner records per-turn metrics

The `AgentRunner` SHALL record a `turn` metric event for every completed assistant turn. It SHALL compute `turnStart` from the `agent_start` event timestamp (or `prompt()` start when `agent_start` is not available), `turnEnd` from the `turn_end` event timestamp, and `durationMs` as the difference. It SHALL copy `usage`, `model`, `provider`, `api`, `responseModel`, `stopReason`, and `errorMessage` from the `turn_end` message. It SHALL count `toolCount` and `toolErrorCount` from `tool_execution_start` and `tool_execution_end` events that occur between the start and end of the turn. The event SHALL be written to the `MetricsStore` for the session.

#### Scenario: Assistant turn completes with usage

- **WHEN** `AgentRunner` handles a complete assistant turn with a `turn_end` containing `usage` and `stopReason`
- **THEN** a `turn` metric event SHALL be written to `metrics.jsonl`
- **AND** the event SHALL contain `durationMs`, `usage`, `cacheRead`, `cacheWrite`, `cost`, `toolCount`, `toolErrorCount`, and `stopReason`

#### Scenario: Tool error is counted

- **WHEN** a `tool_execution_end` event fires with `isError: true` during a turn
- **THEN** the `turn` event for that turn SHALL have `toolErrorCount` incremented by one

#### Scenario: Turn aborted before turn_end

- **WHEN** a turn is aborted and no `turn_end` arrives
- **THEN** no `turn` metric event SHALL be written
- **AND** any partial tool counts from the turn SHALL be discarded

### Requirement: AgentRunner provides MetricsStore to MemoryReflector

The `AgentRunner` SHALL pass a `MetricsStore` (or its session-scoped accessor) to `MemoryReflector` when constructing the default reflector. When a `MemoryReflector` is provided via `AgentRunnerOptions`, the `AgentRunner` SHALL NOT override it.

#### Scenario: Default MemoryReflector receives metrics

- **WHEN** `AgentRunner` is constructed without a `memoryReflector` option
- **THEN** the default `MemoryReflector` SHALL receive the `MetricsStore` for the runner's session

#### Scenario: Injected MemoryReflector is preserved

- **WHEN** `AgentRunner` is constructed with `memoryReflector` set
- **THEN** the provided `MemoryReflector` SHALL be used unchanged
- **AND** the runner SHALL NOT replace it with a new one

### Requirement: AgentRunner exposes metrics API on the runner

The `AgentRunner` SHALL expose a `metrics: MetricsStore` getter (or equivalent) so callers can record additional events for the session. The `MetricsStore` SHALL be available immediately after construction, before `init()` is called.

#### Scenario: Command handler records a counter

- **WHEN** `/debug` or another caller calls `runner.metrics.incrementCounter("manual", "session")`
- **THEN** the counter event SHALL be written to the current session's `metrics.jsonl`

#### Scenario: Metrics are available before the first prompt

- **WHEN** `AgentRunner` is constructed and `metrics` is accessed before `prompt()` is called
- **THEN** it SHALL return a `MetricsStore` bound to the runner's session

# external-agents

## ADDED Requirements

### Requirement: ExternalAgentRunner records per-run metrics

`ExternalAgentRunner` SHALL accept an optional `metrics` dependency of type `MetricsStore` (or a per-session metric writer factory) and use it to record external-agent events to the session's `metrics.jsonl`. The runner SHALL create a `MetricsStore` keyed by the run's `sessionId` when no dependency is supplied, and SHALL record metrics for the run's start, terminal transition, and PTY fallback. Metrics recording failures SHALL be logged and SHALL NOT prevent the run from continuing.

#### Scenario: Run start records a counter

- **WHEN** `ExternalAgentRunner.start()` is called with a backend, task, and session id
- **THEN** `MetricsStore.incrementCounter("external_agent_run_started_total", backend)` SHALL be invoked
- **AND** the run SHALL be tracked and started as before

#### Scenario: Run terminal transition records outcome counters

- **WHEN** a run transitions to `completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`
- **THEN** `MetricsStore.incrementCounter("external_agent_run_<status>_total", backend)` SHALL be invoked
- **AND** a `MetricsStore.record({ type: "external_agent_run", ... })` event SHALL be appended with `backend`, `status`, `durationMs`, `adapterKind`, and `startedAt`/`endedAt` timestamps

#### Scenario: PTY fallback is recorded

- **WHEN** a native adapter signals `InteractiveRequiredError` and `ptyFallback` is enabled
- **THEN** the runner SHALL record the fallback with `MetricsStore.incrementCounter("external_agent_pty_fallback_total", backend)`
- **AND** the run SHALL continue through the PTY adapter as before

### Requirement: ExternalAgentRunner tracks run duration

Each `InternalRun` SHALL record `runStartedAt` when the adapter begins execution and `runEndedAt` when the run becomes terminal. The `external_agent_run` event's `durationMs` SHALL equal `runEndedAt - runStartedAt` as a non-negative number. If a run is interrupted before `runStartedAt` is set, `durationMs` SHALL be `0`.

#### Scenario: Completed run has positive duration

- **WHEN** a run starts and later completes
- **THEN** the recorded `external_agent_run` event SHALL have `durationMs` equal to the wall-clock time between execution start and terminal transition

#### Scenario: Interruption during startup has zero duration

- **WHEN** a run is interrupted before the adapter begins execution
- **THEN** the recorded `external_agent_run` event SHALL have `durationMs` equal to `0`

### Requirement: ExternalAgentRunner records concurrency utilization

`ExternalAgentRunner` SHALL emit an `external_agent_concurrency` event whenever a concurrency slot is acquired or released. The event SHALL include `active` (the number of currently executing runs), `waiting` (the number of queued start requests), and `max` (the configured `maxConcurrent`). The event SHALL be recorded even when a run is cancelled or times out.

#### Scenario: Concurrent run reaches the cap

- **WHEN** `maxConcurrent` runs are active and another `start` is queued
- **THEN** an `external_agent_concurrency` event SHALL be recorded with `active` equal to `maxConcurrent`, `waiting` equal to `1`, and `max` equal to the configured cap

#### Scenario: Run completion releases a slot

- **WHEN** an active run becomes terminal
- **THEN** an `external_agent_concurrency` event SHALL be recorded with `active` decremented and `waiting` equal to the current queue length

### Requirement: Metrics recording is optional at construction

`ExternalAgentRunner` constructor deps SHALL accept an optional `metrics` property. If `metrics` is absent, the runner SHALL construct a `MetricsStore` instance for each run using `goblinHome` and the run's `sessionId`. If `metrics` is present, the runner SHALL use it directly. Test doubles MAY implement only `record` and `incrementCounter`.

#### Scenario: Runner constructed without metrics dependency

- **WHEN** `ExternalAgentRunner` is constructed without a `metrics` dependency
- **THEN** it SHALL record metrics to per-session `metrics.jsonl` files during runs

#### Scenario: Test runner with stub metrics

- **WHEN** `ExternalAgentRunner` is constructed with a stub that implements `record` and `incrementCounter`
- **THEN** it SHALL call the stub instead of writing to `metrics.jsonl`

### Requirement: External-agent run records do not contain task text

Metrics events for external-agent runs SHALL NOT include the original task text, task instructions, or user prompts. The `external_agent_run` event MAY include `backend`, `status`, `durationMs`, `adapterKind`, and timestamps, but it MUST NOT include `task` or `output` fields.

#### Scenario: Metrics event has no task text

- **WHEN** a run completes and a `external_agent_run` event is recorded
- **THEN** the JSON line SHALL NOT contain the task text
- **AND** the metrics file SHALL remain in the session directory only

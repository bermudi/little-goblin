# Subagent Metrics Design

## Architecture

This change extends the `metrics` module from `session-metrics` with a process-level `MetricsStore` for subagents and instruments `SubagentRunner` to record spawn/revive latency, per-subagent token usage, and terminal-outcome counters. `/debug` reads the persisted summary and renders it alongside the existing live subagent counts.

### Data flow

1. **Store creation** (`src/subagents/runner.ts`):
   - `SubagentRunner` constructs one process-level `MetricsStore` via `MetricsStore.forSubagent(this.cfg.goblinHome)` on construction. This store writes to `state/subagent-metrics.jsonl`.
2. **Spawn/revive** (`src/subagents/runner.ts`):
   - `spawn()` and `revive()` increment `subagent_total` and `subagent_spawn_total`/`subagent_revive_total` and capture `Date.now()` as the start timestamp.
   - The start timestamp is stored on the `SubagentInstance` so `runInstance` can compute latency when the first `agent_start` event arrives.
3. **Run lifecycle** (`src/subagents/execution.ts`):
   - `handleEvent` records a `subagent_spawn` or `subagent_revive` event on the first `agent_start` (`latencyMs` = `agent_start` time - spawn/revive start).
   - On assistant `message_end`, it records a `subagent_turn` event with `durationMs`, `usage`, `cost`, `cacheRead`, `cacheWrite`, `model`, `provider`, `api`, `stopReason`, and `errorMessage`.
   - `markCompleted` increments `subagent_completed_total` and records `subagent_result` with `status: "completed"`.
   - `markErrored` increments `subagent_error_total` and records `subagent_result` with `status: "error"`.
4. **Cancellation and timeout** (`src/subagents/runner.ts` and `src/subagents/tool.ts`):
   - `cancel()` increments `subagent_cancelled_total` and records `subagent_result` with `status: "cancelled"`.
   - `tool.ts` `timeoutReject` calls `runner.recordTimeout(id)` instead of `cancel()`. `recordTimeout` aborts the session, increments `subagent_timeout_total`, and records `subagent_result` with `status: "timeout"`. It does not increment `subagent_cancelled_total`.
5. **Surface** (`src/diagnostics.ts`):
   - `gatherDiagnostics` calls `readSubagentMetricsSummary(deps.goblinHome)` and adds `subagentMetrics` to `Diagnostics`.
   - `formatDiagnostics` renders total subagents, completed, cancelled, errors, timeouts, average spawn/revive latency, total tokens/cost/cache, and the most recent subagent status.

## Decisions

### Subagent metrics live in a single process-level file

- **Chosen**: One `MetricsStore` writing to `state/subagent-metrics.jsonl`, shared across all subagents spawned in the process. Per-subagent identity is carried in the `scope` field of `counter`/`event` entries.
- **Why**: `SubagentRunner` is process-wide (one instance in `buildBot`), and `spawnedBy` can be a subagent id for nested runs, so there is no single session id to key a per-session file. A single file avoids scanning many directories and keeps cumulative counters cheap.
- **Trade-off**: The file may grow; if it becomes large, a later change can compact or shard by subagent id. For now, subagent volume is low.
- **Cited decision**: `0014-metrics-file-location` (the `metrics` module owns JSONL files; `session-metrics` established the `MetricsStore` pattern).

### `MetricsStore` exposes `forSubagent` alongside `forSession`

- **Chosen**: `MetricsStore.forSubagent(home)` returns a store for `state/subagent-metrics.jsonl`; `MetricsStore.forSession(home, sessionId)` (from `session-metrics`) remains for per-session files.
- **Why**: Static factories make the destination explicit. The constructor can remain private to the `metrics` module, so callers cannot accidentally write to an arbitrary path.
- **Trade-off**: `forSubagent` introduces a second file location managed by `metrics`. If more process-level stores appear, a `forProcess(scope)` generalization can be added later.

### `SubagentRunner` owns the subagent metrics store, not `AgentRunner`

- **Chosen**: `SubagentRunner` constructs the `MetricsStore` and passes it into `runInstance` via `ExecutionDeps`.
- **Why**: `SubagentRunner` is the lifecycle owner and is already process-wide. `AgentRunner` is per-session, and nested subagents have parent subagent ids, so a per-session store would require ancestry tracking or per-subagent stores.
- **Alternative considered**: Passing a `MetricsStore` from `AgentRunner` to each `spawn_subagent` call. Rejected because it would not naturally cover nested subagents spawned by subagents.

### Latency is measured from `spawn`/`revive` call to first `agent_start`

- **Chosen**: `spawn()` and `revive()` capture `Date.now()` before returning the handle; `runInstance` records the latency when the `agent_start` event arrives.
- **Why**: This captures the wall-clock time the caller waits before the subagent begins processing, including session creation and model setup. It does not include the full turn duration (which is captured in `subagent_turn` `durationMs`).
- **Trade-off**: If `agent_start` never fires, no latency event is recorded. This is acceptable because such a case is captured by an `error` result.

### `recordTimeout` is a separate public method

- **Chosen**: `SubagentRunner` adds `recordTimeout(id)` and `tool.ts` calls it instead of `cancel()` on timeout.
- **Why**: Keeps `cancel()` purely for user-initiated cancellation and `recordTimeout` purely for timeout-triggered cancellation. This avoids double-counting a timeout as both a cancellation and a timeout.
- **Trade-off**: `recordTimeout` duplicates some abort logic with `cancel()`. The implementation can share a private helper to avoid code duplication.

## File Changes

### New files

- `src/metrics/subagent.ts` (optional) — `readSubagentMetricsSummary` and `SubagentMetricsSummary` type. If `store.ts` is small, these can live in `src/metrics/store.ts`.
- `src/metrics/subagent.test.ts` (optional) — tests for `readSubagentMetricsSummary`.
- `src/subagents/subagent-metrics.test.ts` (optional) — tests for `SubagentRunner` metric recording.

### Modified files

- `src/metrics/store.ts`
  - Add `MetricsStore.forSubagent(home)` static factory.
  - Add `subagentMetricsPath(home)` returning `state/subagent-metrics.jsonl`.
  - Add `readSubagentMetricsSummary(home)` and `SubagentMetricsSummary` type.
  - Relates to `metrics` spec `MetricsStore provides a process-level subagent store` and `metrics module exposes readSubagentMetricsSummary`.

- `src/metrics/mod.ts`
  - Re-export `readSubagentMetricsSummary` and `SubagentMetricsSummary`.
  - Relates to `metrics` spec `metrics module exposes readSubagentMetricsSummary`.

- `src/subagents/runner.ts`
  - Import `MetricsStore` and construct `this.metrics = MetricsStore.forSubagent(this.cfg.goblinHome)` in the constructor.
  - Add `startTime` to `SubagentInstance` in `spawn()` and `revive()`.
  - In `spawn()`, increment `subagent_total` and `subagent_spawn_total` before kicking off `runInstance`.
  - In `revive()`, increment `subagent_total` and `subagent_revive_total`.
  - Pass `this.metrics` to `ExecutionDeps`.
  - In `cancel()`, increment `subagent_cancelled_total` and record `subagent_result` with `status: "cancelled"` when a running subagent is cancelled.
  - Add `recordTimeout(id)` that aborts the subagent, increments `subagent_timeout_total`, and records `subagent_result` with `status: "timeout"`.
  - Relates to `subagents` spec `SubagentRunner records spawn and revive latency`, `Cancel subagent records a cancelled metric`, and `SubagentRunner exposes recordTimeout`.

- `src/subagents/execution.ts`
  - Add `metricsStore: MetricsStore` to `ExecutionDeps`.
  - In `_runInstanceInner`, record `subagent_spawn`/`subagent_revive` latency on the first `agent_start` event.
  - On assistant `message_end`, record `subagent_turn` with `durationMs`, `usage`, `cost`, `cacheRead`, `cacheWrite`, `model`, `provider`, `api`, `stopReason`, and `errorMessage`.
  - In `markCompleted`, increment `subagent_completed_total` and record `subagent_result` with `status: "completed"`.
  - In `markErrored`, increment `subagent_error_total` and record `subagent_result` with `status: "error"`.
  - Relates to `subagents` spec `SubagentRunner records spawn and revive latency`, `SubagentRunner records token usage per subagent`, and `SubagentRunner records completion and error outcomes`.

- `src/subagents/types.ts`
  - Add `startTime?: number` to `SubagentInstance` for latency measurement.
  - Relates to `subagents` spec `SubagentRunner records spawn and revive latency`.

- `src/subagents/tool.ts`
  - Change `timeoutReject` to call `runner.recordTimeout(id)` instead of `runner.cancel(id)`.
  - Relates to `subagents` spec `SubagentRunner exposes recordTimeout`.

- `src/diagnostics.ts`
  - Import `readSubagentMetricsSummary` and `SubagentMetricsSummary` from `src/metrics/mod.ts`.
  - Add `subagentMetrics: SubagentMetricsSummary | null` to `Diagnostics`.
  - In `gatherDiagnostics`, call `readSubagentMetricsSummary(deps.goblinHome)`.
  - In `formatDiagnostics`, render the subagent metrics section after `Subagents: ...`.
  - Relates to `commands` spec `Debug command includes subagent metrics`.

### No changes needed

- `src/agent/mod.ts` — `AgentRunner` does not need to pass a `MetricsStore` to `SubagentRunner`; the subagent store is process-wide.
- `src/sessions/manager.ts` — subagent metrics are not tied to session lifecycle.
- `src/bot.ts` — `SubagentRunner` constructs its own metrics store; no new wiring required.
- `specs/changes/session-metrics/` — not modified.

## Cross-cutting rule flagged

The `metrics` and `subagents` deltas both reference the `subagent-metrics.jsonl` path. The `metrics` module owns the path helper and the reader, and `subagents` owns the writer; this is the same cross-cutting pattern as `session-metrics` (`sessions` owns `metrics.jsonl` file creation/archival, `metrics` owns contents).

# Subagent Metrics

## Motivation

`session-metrics` introduces a `MetricsStore` for per-session turn, counter, and event records. `SubagentRunner` currently has no observability: spawn/revive latency is not measured, token usage per subagent is lost once the run finishes, and error/cancel/timeout outcomes are only visible in the log stream. `/debug` shows only how many subagents are tracked and running, not how many have completed, errored, timed out, or how much they cost. This change extends the `metrics` counter/event conventions to `SubagentRunner` and surfaces the result in `/debug`.

## Scope

### `subagents` capability (modified)

- `SubagentRunner` SHALL construct a process-level `MetricsStore` for subagent metrics on creation.
- `spawn()` and `revive()` SHALL increment the total subagent counter and start a latency timer.
- `runInstance` SHALL record `subagent_spawn` and `subagent_revive` latency events when the run begins (`agent_start`) and `subagent_turn` events with `usage`/`cost`/`cacheRead`/`cacheWrite`/`stopReason`/`errorMessage` from the assistant `message_end`.
- `cancel()` SHALL increment `subagent_cancelled_total` when it aborts a running subagent.
- `markCompleted` SHALL increment `subagent_completed_total`.
- `markErrored` SHALL increment `subagent_error_total`.
- `recordTimeout(id)` SHALL be added to `SubagentRunner` and called by `tool.ts` when `Promise.race` fires the timeout, incrementing `subagent_timeout_total`.
- `ExecutionDeps` and `SubagentInstance` MAY be extended to carry the `MetricsStore` reference, but the public `SubagentRunner` surface remains unchanged except for `recordTimeout`.

### `metrics` capability (new/extended)

- `MetricsStore` SHALL expose `forSubagent(home)` returning a process-level store that writes to `$GOBLIN_HOME/state/subagent-metrics.jsonl`.
- `MetricsStore` SHALL continue to support `forSession(sessionId)` (from `session-metrics`) unchanged.
- `MetricsStore` SHALL record `event` and `counter` entries with the same append-only JSONL semantics as session metrics.
- The `metrics` module SHALL expose `readSubagentMetricsSummary(home)` that scans `subagent-metrics.jsonl` and returns:
  - `totalSubagents`, `completed`, `cancelled`, `errors`, `timeouts`;
  - `avgSpawnLatencyMs`, `avgReviveLatencyMs`;
  - `totalTokens`, `totalCost`, `totalCacheRead`, `totalCacheWrite`;
  - a per-subagent breakdown keyed by `scope`.

### `commands` capability (modified)

- `/debug` (`src/diagnostics.ts`) SHALL read `SubagentMetricsSummary` and include subagent metrics in the diagnostics output:
  - Total subagents spawned/revived, completed, cancelled, errored, timed out.
  - Average spawn/revive latency.
  - Total subagent tokens, cost, cache read/write.
  - A summary line for the most recent subagent (last turn tokens/cost/status).
- The output SHALL remain instant-timing and read-only.

## Non-Goals

- No new Telegram command or change to `/subagents` list output.
- No modification to `session-metrics` files or the per-session `metrics.jsonl` schema.
- No external metrics backend, Prometheus/OTel, or streaming exporter.
- No scheduler, ASR, memory, or external-agent metrics.
- No per-provider dashboards or cross-session aggregation beyond the process-level subagent summary.
- No synthetic `/subagent_metrics` command; visibility is via `/debug` only.

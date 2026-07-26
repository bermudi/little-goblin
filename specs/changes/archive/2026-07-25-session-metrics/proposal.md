# Session Metrics

## Motivation

Goblin persists per-message `usage` (input, output, cacheRead, cacheWrite, totalTokens, cost) in `transcript.jsonl`, but that data is never surfaced to the user. There is no per-turn latency, no per-session cost/cache aggregation, no durable record of tool counts or stop reasons, and no visibility into memory write/search volume. `/debug` only shows transcript size and line count. The result is that users cannot reason about cache hit/miss, turn latency, or cumulative spend.

This change adds a small, per-session `metrics.jsonl` and a new `MetricsStore` module, then wires the most important consumers (agent turns, memory writes/reflection/search, and `/debug`) so that session-level metrics become visible without touching the pi SDK or adding an external metrics backend.

## Scope

### New `metrics` capability

- Add a `MetricsStore` module at `src/metrics/store.ts` that owns all writes to `$GOBLIN_HOME/state/sessions/<id>/metrics.jsonl`.
- Define a typed `MetricsEvent` union with at least:
  - `turn` — `turnStart`, `turnEnd`, `durationMs`, `model`, `provider`, `api`, `usage`, `cost`, `cacheRead`, `cacheWrite`, `toolCount`, `toolErrorCount`, `stopReason`, `errorMessage`.
  - `counter` — `name`, `scope`, `value` (for cumulative/increment counters such as `memory_write_total`, `memory_write_overflow`, `memory_search_total`, `memory_reflection_candidate`, `memory_quarantine`).
  - `event` — `name`, `sessionId`, `scope`, `extra` (for point-in-time events such as `memory_search` and `snapshot_built`).
- Writes are append-only JSONL with atomic temp+rename for the initial file creation and line-at-a-time `openSync`/`writeSync`/`closeSync` for appends.
- Provide `MetricsStore.forSession(sessionId)` (or equivalent) keyed by session, and a process-wide singleton created at composition time.
- Add `metricsPath(home, sessionId)` to `src/sessions/paths.ts`.

### `sessions` capability

- `SessionManager.createForChat()` creates an empty `metrics.jsonl` alongside `transcript.jsonl` and `events.jsonl`.
- `SessionManager.archive()` moves `metrics.jsonl` with the session directory to `sessions/archive/<id>/`.
- The `sessions` spec is updated to list `metrics.jsonl` in the session filesystem layout.

### `agent` capability

- `AgentRunner` records a `turn` event for every completed assistant turn:
  - `turnStart` from `agent_start` or the first `prompt()` call, `turnEnd` from `message_end` (assistant role), `durationMs` from those two timestamps.
  - `usage` copied from `message_end.usage` (input, output, cacheRead, cacheWrite, totalTokens, cost).
  - `toolCount` and `toolErrorCount` counted from `tool_execution_start`/`tool_execution_end` observed in the turn.
  - `stopReason`, `errorMessage`, `model`, `provider`, `api` from the `message_end` message.
- `AgentRunner` passes the `MetricsStore` (or its session-scoped accessor) to `MemoryReflector` so reflection can record counters.

### `commands` capability

- `/debug` (`src/diagnostics.ts`) reads the last N `metrics.jsonl` entries for the current session and prints:
  - Last turn: tokens, cost, cacheRead/cacheWrite, stopReason.
  - Session totals: total tokens, total cost, cache read/write totals, average turn duration, total tool calls.
  - Memory counters: writes, overflows, safety rejections, searches, average search result count, reflection candidates, quarantined candidates.
  - Cache summary line such as `Cache: <k> read / <k> write tokens in this session`.
- The `Diagnostics` type and `formatDiagnostics` are extended; `/debug` remains instant-timing.

### `memory` capability

- `MemoryStore` records counters for every write outcome: `memory_write_<action>_total`, `memory_write_overflow_total`, `memory_write_safety_reject_total`, `memory_archive_orphan_total`.
- `memory_search` records a `memory_search` event with `query`, `scopes`, `resultCount`, `limit`.
- `MemoryReflector` records counts for extracted candidates, persisted candidates, and each quarantine reason (`unsafe`, `low_confidence`, `procedural_noise`, `review`).
- `formatSnapshot` (optional for this change) records `snapshot_built` events with `empty`, `entryCount`, `charLength` when a non-null snapshot is produced.

## Non-Goals

- No subagent, external-agent, scheduler, Telegram API, ASR/TTS, or lifecycle metrics in this change.
- No per-provider or cross-session dashboards; aggregation is per-session only.
- No external metrics backend, no Prometheus/OTel, no real-time streaming exporter.
- No changes to the pi SDK or `transcript.jsonl` schema; `metrics.jsonl` is a separate, derived stream.
- No synthetic `/metrics` command beyond extending `/debug`.

## Scope Note

This change touches five capabilities (`metrics`, `sessions`, `agent`, `commands`, `memory`). It is intentionally kept as one change because it is a single vertical slice: record turn/memory data, persist it, and display it in `/debug`. If review finds it too large, it can be split into `metrics-core` (the module and `metrics.jsonl`) and `debug-metrics` (the `/debug` surface and memory counters).

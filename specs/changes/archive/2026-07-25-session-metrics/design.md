# Session Metrics Design

## Architecture

A new `metrics` module is introduced as the single writer and reader of per-session `metrics.jsonl`. `AgentRunner` creates a session-scoped `MetricsStore` and passes it to `MemoryStore` and `MemoryReflector`, so turn, memory, and reflection metrics are recorded as the session lives. `SessionManager` ensures the file exists on creation and moves it with the session directory on archive. `diagnostics.ts` reads `metrics.jsonl` through the `metrics` module's `readMetricsSummary` helper, so `/debug` can display metrics even when no runner is in memory.

### Data flow

1. **Turn recording** (`src/agent/mod.ts`):
   - `AgentRunner` already receives `message_end`, `tool_execution_start`, `tool_execution_end`, and `agent_start` events in `handleEvent`.
   - It records a `turn` event at the end of an assistant message using the turn's start/end timestamps and the `usage` object from `message_end`.
   - It also records `toolCount` and `toolErrorCount` from tool events observed during the turn.
2. **Memory recording** (`src/memory/store.ts`, `src/memory/reflector.ts`, `src/memory/search.ts`):
   - `MemoryStore` increments `memory_write_*` counters on each successful `add`/`replace`/`remove`/`rewrite`/`set_description`, and increments `memory_write_overflow_total` and `memory_write_safety_reject_total` on failures.
   - `MemoryReflector` increments `memory_reflection_candidate_total`, `memory_reflection_persisted_total`, and `memory_reflection_quarantine_total` with the reason as the counter scope.
   - `searchMemoryEntries` writes a `memory_search` event with `resultCount` and `scopes`.
   - `formatSnapshot` writes a `snapshot_built` event when the snapshot is non-empty.
3. **Persistence** (`src/metrics/store.ts`):
   - `MetricsStore` owns `metrics.jsonl` at `state/sessions/<id>/metrics.jsonl`.
   - `MetricsStore.record` writes one JSONL line with `openSync`/`writeSync`/`closeSync` in append mode.
   - `MetricsStore.incrementCounter` reads the last value for a `(name, scope)` from the file and writes a new cumulative `counter` event.
   - `readMetricsSummary(home, sessionId)` scans all lines and returns a `MetricsSummary` for `/debug`.
4. **Surface** (`src/diagnostics.ts`):
   - `gatherDiagnostics` calls `readMetricsSummary` and adds `metrics: MetricsSummary | null` to the `Diagnostics` snapshot.
   - `formatDiagnostics` renders turns, tokens, cost, cache, and memory counters.

## Decisions

### `metrics.jsonl` lives in the session directory

- **Chosen**: `state/sessions/<id>/metrics.jsonl`, created by `SessionManager`, written by `MetricsStore`, moved by `SessionManager.archive`.
- **Why**: This keeps metrics tied to the session lifecycle and lets `/debug` read them from disk using only the session id. It also matches how `transcript.jsonl` and `events.jsonl` are already owned by `sessions` for paths but by other modules for contents.
- **Cited decision**: `0014-metrics-file-location`.

### `MetricsStore` is the single writer, but `readMetricsSummary` is exposed for diagnostics

- **Chosen**: `src/metrics/store.ts` writes all `metrics.jsonl` lines and exposes `readMetricsSummary` (or static `MetricsStore.readSummary`).
- **Why**: Centralizing writes avoids multiple modules appending with different formatting, and a single reader lets `diagnostics.ts` compute summaries without duplicating parsing logic.
- **Trade-off**: `readMetricsSummary` must scan the whole file. For now, `metrics.jsonl` is small per session; if it grows, we can add a `MetricsStore` in-memory cache or `metrics.idx` later.

### Counters are cumulative events, not deltas

- **Chosen**: Each `counter` event stores the new absolute value (e.g., `value: 3`).
- **Why**: Cumulative values make `readMetricsSummary` trivial: the last line for a `(name, scope)` is the current value, and `incrementCounter` can read that line. It also makes the JSONL stream human-readable and crash-safe.
- **Trade-off**: The file grows one line per counter increment; if this becomes an issue, compaction can be added later.

### `AgentRunner` owns the `MetricsStore` for its session

- **Chosen**: Each `AgentRunner` constructs a `MetricsStore(this.cfg.goblinHome, this.sessionId)` and passes it to `MemoryStore` and `MemoryReflector`.
- **Why**: The `AgentRunner` already knows the session id and is the only component that can observe a complete turn's start/end and tool events. This avoids passing `MetricsStore` through `TurnDispatcher` or `TelegramIntake`.
- **Alternative considered**: A process-wide `MetricsStore` singleton keyed by session id. Rejected because it would require a map and lifecycle, and each runner already has a session.

### `MemoryStore` is kept per-runner; the `metrics` instance is passed to it

- **Chosen**: `MemoryStore` constructor accepts an optional `metrics` argument; the `AgentRunner` passes `this.metrics`.
- **Why**: `AgentRunner` already creates a fresh `MemoryStore` per runner. The `MemoryStore` in `bot.ts` is only used for topic-name lookups and does not write, so it does not need a `MetricsStore`.

### Cache numbers are read from `usage.cacheRead`/`usage.cacheWrite` and also mirrored at the top level of the turn event

- **Chosen**: The `turn` event includes `cacheRead` and `cacheWrite` both inside `usage` and as top-level fields.
- **Why**: `readMetricsSummary` can sum the top-level numeric fields without reaching into nested `usage`. The nested `usage` stays the source of truth for `transcript.jsonl` parity.

## File Changes

### New files

- `src/metrics/store.ts` — `MetricsStore` class, `MetricsEvent` types, `MetricsSummary` type, `readMetricsSummary` helper.
- `src/metrics/mod.ts` — barrel re-exporting `MetricsStore`, `MetricsEvent`, `MetricsSummary`, and `readMetricsSummary`.
- `src/metrics/store.test.ts` — tests for `record`, `incrementCounter`, `readMetricsSummary`, missing-file handling, and append semantics.
- `src/metrics/types.ts` (optional) — if `store.ts` becomes too large, extract `MetricsEvent` and `MetricsSummary` types here.

### Modified files

- `src/sessions/paths.ts`
  - Add `metricsPath(home, id)` using `sessionDir` and `validateSessionId`.
  - Relates to `metrics` spec `metrics.jsonl path is exported by sessions/paths.ts`.

- `src/sessions/manager.ts`
  - Update `ensureSessionFiles` to create an empty `metrics.jsonl` alongside `transcript.jsonl`.
  - Relates to `sessions` spec `Create session filesystem layout` and `metrics` spec `metrics.jsonl is created on session creation and archived with the session`.
  - `archive()` already renames the whole session directory, so `metrics.jsonl` moves automatically; no extra code required.

- `src/agent/mod.ts`
  - Add `metrics: MetricsStore` private field and expose `metrics` getter.
  - Construct `MetricsStore` in the constructor: `this.metrics = new MetricsStore(opts.cfg.goblinHome, this.sessionId)`.
  - Pass `this.metrics` to `new MemoryStore(opts.cfg.goblinHome, this.metrics)` and `new MemoryReflector({ ... metrics: this.metrics })`.
  - In `handleEvent`, track `turnStart` from `agent_start` (or `prompt()` start), accumulate tool counts, and record a `turn` event on `message_end` with role `assistant`.
  - Relates to `agent` spec `AgentRunner records per-turn metrics`, `AgentRunner provides MetricsStore to MemoryReflector`, and `AgentRunner exposes metrics API on the runner`.

- `src/memory/store.ts`
  - Add optional `metrics?: MetricsStore` constructor parameter.
  - In `add`, `replace`, `remove`, `rewrite`, `setDescription`, call `metrics?.incrementCounter(...)` on success.
  - In cap-overflow and safety paths, call `metrics?.incrementCounter(...)` on failure.
  - In `archiveOrphan` (or the equivalent archive-on-rename path), call `metrics?.incrementCounter("memory_archive_orphan_total", scopeTag)`.
  - Relates to `memory` spec `Memory store records write metrics`.

- `src/memory/reflector.ts`
  - Add optional `metrics?: MetricsStore` constructor parameter.
  - After candidate extraction and persistence, call `metrics?.incrementCounter("memory_reflection_candidate_total", null, candidateCount)` and `metrics?.incrementCounter("memory_reflection_persisted_total", null, persistedCount)`.
  - For each quarantined candidate, call `metrics?.incrementCounter("memory_reflection_quarantine_total", reason)`.
  - Relates to `memory` spec `MemoryReflector records reflection metrics`.

- `src/memory/search.ts`
  - Add optional `metrics?: MetricsStore` parameter to `searchMemoryEntries`.
  - After search completes, write a `memory_search` event with `query`, `scopes`, `resultCount`, and `limit`.
  - Relates to `memory` spec `Memory search records query metrics`.

- `src/memory/snapshot.ts` (or wherever `formatSnapshot` is defined)
  - Add optional `metrics?: MetricsStore` parameter.
  - When a non-empty snapshot is built, write a `snapshot_built` event.
  - Relates to `memory` spec `Snapshot build records snapshot metrics`.

- `src/diagnostics.ts`
  - Add `metrics: MetricsSummary | null` to `Diagnostics` interface.
  - In `gatherDiagnostics`, call `readMetricsSummary(deps.goblinHome, deps.session.id)` and assign to `metrics`.
  - In `formatDiagnostics`, render last-turn tokens/cost/cache, totals, memory counters, and cache summary line.
  - Relates to `commands` spec `Debug command dumps diagnostics` and `metrics` spec `MetricsStore exposes readMetricsSummary helper`.

- `src/commands/registry.ts`
  - The `debugHandler` continues to call `generateDiagnostics` with the same `DiagnosticsDeps`; no signature change is needed because `generateDiagnostics` reads metrics from disk.

### No changes needed

- `src/commands/dispatch.ts` — `/debug` timing is still instant and `debugHandler` is unchanged.
- `src/bot.ts` — `AgentRunner` constructs its own `MetricsStore`; no new wiring is needed at the bot level.
- `src/tg/intake.ts` — No change; `AgentRunner` receives the same constructor options and `MetricsStore` is internal.

## Cross-cutting rule flagged

The `sessions` delta and `metrics` delta both contain the imperative rule "`metrics.jsonl` is created by `SessionManager` and archived with the session." This is a filesystem-layout cross-cutting concern. It is captured in ADR `0014-metrics-file-location` and referenced above.

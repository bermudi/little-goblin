# External Agent Metrics Design

## Architecture

`ExternalAgentRunner` becomes a consumer of the `metrics` capability added by `session-metrics`. Each run writes to the session's `metrics.jsonl` through a `MetricsStore` keyed by the run's `sessionId`. The runner records start counters, terminal outcome counters, a per-run `external_agent_run` event with duration, concurrency events, and PTY fallback counters. `src/diagnostics.ts` reads the existing `metrics.jsonl` via `readMetricsSummary` and renders an external-agent section in `/debug`.

### Data flow

1. **Run start** (`src/external-agents/runner.ts`):
   - When `start()` acquires a concurrency slot and creates a run, the runner increments `external_agent_run_started_total` scoped by backend.
   - If the concurrency slot was immediately available, it records `external_agent_concurrency` with `active`, `waiting = 0`, and `max`.
   - If the start had to wait in the concurrency queue, it records `external_agent_concurrency` with `waiting > 0` and the run is also counted as `external_agent_run_started_total` once the slot is acquired.
2. **Run execution** (`src/external-agents/runner.ts`):
   - `runStartedAt` is set when the adapter begins executing (after `handle.waitForExit` is awaited or when `handle` is assigned for event-driven adapters).
   - PTY fallback increments `external_agent_pty_fallback_total` by backend and updates `run.adapterKind` to `pty`.
3. **Run terminal** (`src/external-agents/runner.ts`):
   - `transitionTerminal` sets `runEndedAt` and emits the terminal event.
   - `handleEvent` records an `external_agent_run` event with `backend`, `status`, `durationMs`, `adapterKind`, `startedAt`, and `endedAt`.
   - The outcome counter `external_agent_run_<status>_total` is incremented by backend.
   - `external_agent_concurrency` is recorded with updated `active` and `waiting` counts.
4. **Read path** (`src/diagnostics.ts`):
   - `gatherDiagnostics` calls `readMetricsSummary(home, sessionId)` and receives the `MetricsSummary` with `externalAgent`.
   - `formatDiagnostics` renders the external-agent section when `metrics.externalAgent` is present and has runs.

## Decisions

### `ExternalAgentRunner` constructs a per-session `MetricsStore` lazily

- **Chosen**: `ExternalAgentRunner` accepts an optional `metrics` dependency and, when absent, creates `new MetricsStore(cfg.goblinHome, sessionId)` for each run. If a shared `MetricsStore` is supplied, the runner uses it directly.
- **Why**: The runner is process-wide but runs are owned by Goblin sessions. The `MetricsStore` API is already keyed by `sessionId`, so per-run construction fits the existing `MetricsStore` design without adding a registry or map to the runner.
- **Trade-off**: Multiple concurrent runs in the same session will each open/append to the same `metrics.jsonl`; `MetricsStore` must use `openSync`/`writeSync`/`closeSync` per line (as already specified by `session-metrics`) so the append remains safe.
- **Cited decision**: `0014-metrics-file-location`.

### Counters are cumulative and scoped by backend

- **Chosen**: Each `external_agent_run_*_total` counter stores the new absolute value for each `(name, backend)` pair.
- **Why**: `MetricsStore.incrementCounter` already reads the last value for a `(name, scope)` and writes a new cumulative value. Scoping by backend lets `/debug` report per-backend outcomes without parsing every event.
- **Trade-off**: Six outcome counters per backend plus one start counter and one PTY fallback counter means up to 8 counter lines per run; this is acceptable for the expected volume of external-agent runs.

### `external_agent_run` event captures duration and adapter kind

- **Chosen**: The `external_agent_run` event includes `durationMs`, `adapterKind`, `startedAt`, and `endedAt`.
- **Why**: The event stream provides the raw data for average runtime and PTY fallback frequency. `readMetricsSummary` can compute averages by scanning these events rather than relying solely on counter snapshots.
- **Trade-off**: Each terminal run adds one event line; the file grows slowly and the read scan remains fast for per-session files.

### Concurrency is reported as events, not gauges

- **Chosen**: The `metrics` stream receives `external_agent_concurrency` events with `active`, `waiting`, and `max` at start and terminal transitions.
- **Why**: `MetricsStore` is append-only and not a metrics backend. Events capture the instantaneous concurrency utilization over time and let `readMetricsSummary` report the most recent state.
- **Trade-off**: `lastConcurrency` is not a real-time gauge; it reflects the last recorded event in the current session.

### `/debug` does not add a new command

- **Chosen**: External-agent metrics are rendered inside the existing `/debug` output.
- **Why**: `session-metrics` already extends `/debug` with memory and turn metrics; adding another section is the smallest, most consistent surface.
- **Trade-off**: `/debug` output grows longer; if it becomes unwieldy, a separate `/debug external-agents` mode can be added later.

## File Changes

### Modified files

- `src/external-agents/runner.ts`
  - Add optional `metrics` field to `ExternalAgentRunnerDeps` and `ExternalAgentRunner`.
  - Add `metrics` construction logic in `start()` keyed by `args.sessionId` when not provided.
  - Add `runStartedAt` and `runEndedAt` to `InternalRun` and set them in `executeRun` and `transitionTerminal`.
  - In `executeRun`, record `external_agent_concurrency` after `concurrencyLimiter.acquire` and again after the run finishes.
  - In `start()` and the terminal transition path, call `metrics.incrementCounter` for `external_agent_run_started_total` and `external_agent_run_<status>_total`.
  - In `handleEvent`, record `external_agent_run` event for terminal event types.
  - In the PTY fallback path in `executeRun`, call `metrics.incrementCounter("external_agent_pty_fallback_total", backend)`.
  - Relates to `external-agents` spec `ExternalAgentRunner records per-run metrics`, `ExternalAgentRunner tracks run duration`, `ExternalAgentRunner records concurrency utilization`, and `Metrics recording is optional at construction`.

- `src/external-agents/types.ts`
  - Add `runStartedAt?: string` and `runEndedAt?: string` to `InternalRun`.
  - Relates to `ExternalAgentRunner tracks run duration`.

- `src/metrics/store.ts`
  - Add `external_agent_run` and `external_agent_concurrency` to the `MetricsEvent` union.
  - Update `MetricsSummary` to include `externalAgent` with `runsByBackend`, `outcomesByBackend`, `totalRuns`, `averageDurationMs`, `averageDurationByBackend`, `ptyFallbackByBackend`, `totalPtyFallbacks`, and `lastConcurrency`.
  - Implement `readMetricsSummary` aggregation for external-agent counters and events.
  - Relates to `metrics` spec `MetricsEvent types include external-agent metrics` and `readMetricsSummary includes external-agent metrics`.

- `src/metrics/mod.ts`
  - Export updated `MetricsEvent` and `MetricsSummary` types.
  - Relates to `metrics` capability exports.

- `src/diagnostics.ts`
  - Add `externalAgent` rendering to `formatDiagnostics` when `metrics` is present.
  - Add helper functions to format per-backend counts, average runtime, and PTY fallback counts.
  - Relates to `commands` spec `Debug command includes external-agent metrics` and `Diagnostics type includes external-agent metrics`.

### New files

- `src/external-agents/runner.test.ts` (or extend existing tests if present)
  - Test that `start()` records a `external_agent_run_started_total` counter.
  - Test that terminal transitions record outcome counters and `external_agent_run` events.
  - Test that PTY fallback increments `external_agent_pty_fallback_total`.
  - Test that `durationMs` is non-negative and `external_agent_concurrency` events are recorded.
  - Relates to `external-agents` spec `ExternalAgentRunner records per-run metrics` and `ExternalAgentRunner tracks run duration`.

- `src/metrics/store.test.ts` (or extend existing tests if added by `session-metrics`)
  - Test `readMetricsSummary` external-agent aggregation for multiple backends and mixed outcomes.
  - Relates to `metrics` spec `readMetricsSummary includes external-agent metrics`.

- `src/diagnostics.test.ts` (or extend existing tests)
  - Test that `/debug` output includes external-agent metrics when present and omits the section when absent.
  - Relates to `commands` spec `Debug command includes external-agent metrics`.

### No changes needed

- `src/external-agents/tool.ts` — the `external_agent` tool schema and output remain unchanged; metrics are recorded by the runner.
- `src/external-agents/mod.ts` — no new exports are required; metrics are internal to the runner.
- `src/bot.ts` — the `ExternalAgentRunner` is already wired by `external-agent-runner`; this change only adds internal metrics construction.
- `src/commands/registry.ts` — `/debug` timing and handler registration remain unchanged.
- `src/sessions/manager.ts` and `src/sessions/paths.ts` — `metrics.jsonl` lifecycle is already handled by `session-metrics`.

# External Agent Metrics

## Motivation

`session-metrics` introduces a per-session `metrics.jsonl` and a `MetricsStore` API for turn, memory, and `/debug` observability. `ExternalAgentRunner` already owns run lifecycle, status transitions, concurrency limits, and PTY fallback, but it records none of this to the session metrics stream. As a result users cannot see how many external-agent runs succeeded or failed, how long they ran, how often the concurrency limit or PTY fallback was hit, or which backends are used most.

This change extends the `metrics` capability with external-agent event/counter conventions and instruments `ExternalAgentRunner` so that run outcomes, runtime, concurrency, backend usage, and PTY fallback are visible in `/debug` without adding a new external backend or changing the core runner lifecycle.

## Scope

### `external-agents` capability

- `ExternalAgentRunner` accepts an optional `metrics` dependency and records per-session metrics into the existing `metrics.jsonl` file.
- On every run start, increment `external_agent_run_started_total` by backend.
- On every terminal transition, record an `external_agent_run` event with `backend`, `status`, `durationMs`, and `adapterKind` (native or pty).
- On terminal transitions, increment outcome counters by backend:
  - `external_agent_run_completed_total`
  - `external_agent_run_failed_total`
  - `external_agent_run_cancelled_total`
  - `external_agent_run_timed_out_total`
  - `external_agent_run_interrupted_total`
- Record PTY fallback occurrences as `external_agent_pty_fallback_total` by backend.
- Record concurrency events as `external_agent_concurrency` with `active`, `waiting`, and `max` when a run starts or ends.
- Track `runStartedAt` and `runEndedAt` on each run to compute `durationMs`.

### `metrics` capability

- Add `externalAgentRun` and `externalAgentConcurrency` event/counter conventions to the `MetricsEvent` union.
- Extend `readMetricsSummary` to include `externalAgentSummary` with per-backend totals, per-backend average `durationMs`, total terminal runs, and PTY fallback count.
- Define `externalAgentSummary` return shape so `diagnostics.ts` can render it without parsing `metrics.jsonl` directly.

### `commands` capability

- `/debug` (`src/diagnostics.ts`) includes an external-agent metrics section.
- Display per-backend counts for completed, failed, cancelled, timed-out, and interrupted runs.
- Display average runtime per backend and overall.
- Display concurrency utilization (`active / max`) and total PTY fallback count.
- The `Diagnostics` type and `formatDiagnostics` are extended; `/debug` remains instant-timing.

## Non-Goals

- No new external metrics backend, Prometheus, OTel, or real-time exporter.
- No per-provider dashboards or cross-session aggregation beyond `/debug` for the current session.
- No changes to `transcript.jsonl` or `events.jsonl` schemas.
- No new `/metrics` command; external-agent metrics are surfaced only through `/debug`.
- No modification of `session-metrics` planning artifacts; this change is a downstream consumer of the `MetricsStore` API.
- No instrumentation of `SubagentRunner`, `AgentRunner`, memory, or Telegram layer in this change.

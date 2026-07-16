# External Agent Metrics Tasks

## Phase 1: Extend MetricsEvent and MetricsSummary for external-agent metrics

- [ ] Add `external_agent_run` and `external_agent_concurrency` event types to `MetricsEvent` in `src/metrics/store.ts`.
- [ ] Add external-agent outcome counter names (`external_agent_run_started_total`, `external_agent_run_completed_total`, `external_agent_run_failed_total`, `external_agent_run_cancelled_total`, `external_agent_run_timed_out_total`, `external_agent_run_interrupted_total`, `external_agent_pty_fallback_total`) to `MetricsEvent` counter scope conventions.
- [ ] Extend `MetricsSummary` with `externalAgent` fields (`runsByBackend`, `outcomesByBackend`, `totalRuns`, `averageDurationMs`, `averageDurationByBackend`, `ptyFallbackByBackend`, `totalPtyFallbacks`, `lastConcurrency`).
- [ ] Implement `readMetricsSummary` aggregation for external-agent events and counters.
- [ ] Update `src/metrics/mod.ts` to export the updated `MetricsEvent` and `MetricsSummary` types.
- [ ] Add `src/metrics/store.test.ts` tests covering `readMetricsSummary` external-agent aggregation.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 1: extend metrics store and summary for external-agent metrics`

## Phase 2: Instrument ExternalAgentRunner

- [ ] Add optional `metrics` dependency to `ExternalAgentRunnerDeps` and `ExternalAgentRunner` in `src/external-agents/runner.ts`.
- [ ] Add `runStartedAt` and `runEndedAt` to `InternalRun` in `src/external-agents/types.ts`.
- [ ] Set `runStartedAt` when the adapter begins execution and `runEndedAt` in `transitionTerminal`.
- [ ] Record `external_agent_run_started_total` counter in `start()`.
- [ ] Record `external_agent_concurrency` events when a concurrency slot is acquired and released.
- [ ] Record `external_agent_run_<status>_total` counter and `external_agent_run` event on terminal transitions.
- [ ] Record `external_agent_pty_fallback_total` counter when PTY fallback is triggered.
- [ ] Add `src/external-agents/runner.test.ts` tests covering counter and event recording.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 2: instrument external agent runner with metrics`

## Phase 3: Surface external-agent metrics in `/debug`

- [ ] Extend `Diagnostics` in `src/diagnostics.ts` to include `metrics.externalAgent`.
- [ ] Update `formatDiagnostics` to render `External agents:` section with per-backend counts, outcome breakdown, average runtime, concurrency utilization, and PTY fallback count.
- [ ] Add `src/diagnostics.test.ts` tests for external-agent section rendering and absence handling.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 3: surface external-agent metrics in debug`

## Phase 4: Validate and finalize

- [ ] Run `bun run typecheck` and `bun test` for the full change.
- [ ] Run `litespec validate external-agent-metrics` and fix any issues.
- [ ] Review `specs/changes/external-agent-metrics/` for consistency with the source and `session-metrics`.
- [ ] Commit: `phase 4: validate external-agent metrics change`

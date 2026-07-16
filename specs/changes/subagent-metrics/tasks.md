# Subagent Metrics Tasks

## Phase 1: Extend `metrics` module for subagent metrics

- [ ] Add `subagentMetricsPath(home)` to `src/metrics/store.ts` returning `state/subagent-metrics.jsonl`.
- [ ] Add `MetricsStore.forSubagent(home)` static factory to `src/metrics/store.ts`.
- [ ] Add `SubagentMetricsSummary` type and `readSubagentMetricsSummary(home)` to `src/metrics/store.ts`.
- [ ] Re-export `readSubagentMetricsSummary` and `SubagentMetricsSummary` from `src/metrics/mod.ts`.
- [ ] Add `src/metrics/store.subagent.test.ts` covering `readSubagentMetricsSummary` for missing files, counters, events, per-subagent breakdown, and malformed-line skipping.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 1: metrics module subagent store and summary`

## Phase 2: Instrument `SubagentRunner` with subagent metrics

- [ ] Add `startTime?: number` to `SubagentInstance` in `src/subagents/types.ts`.
- [ ] Construct `MetricsStore.forSubagent(this.cfg.goblinHome)` in `SubagentRunner` and pass it through `ExecutionDeps`.
- [ ] Increment `subagent_total`, `subagent_spawn_total`, and `subagent_revive_total` in `spawn()`/`revive()` and store `startTime`.
- [ ] Record `subagent_spawn`/`subagent_revive` latency events in `src/subagents/execution.ts` on `agent_start`.
- [ ] Record `subagent_turn` usage events on assistant `message_end`.
- [ ] In `markCompleted`, increment `subagent_completed_total` and record `subagent_result` `completed`.
- [ ] In `markErrored`, increment `subagent_error_total` and record `subagent_result` `error`.
- [ ] In `cancel()`, increment `subagent_cancelled_total` and record `subagent_result` `cancelled`.
- [ ] Add `recordTimeout(id)` to `SubagentRunner` and wire `src/subagents/tool.ts` `timeoutReject` to call it.
- [ ] Update `src/subagents/test/lifecycle.suite.ts` to assert counters and events are written to `subagent-metrics.jsonl`.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 2: instrument SubagentRunner subagent metrics`

## Phase 3: Surface subagent metrics in `/debug`

- [ ] Add `subagentMetrics: SubagentMetricsSummary | null` to `Diagnostics` in `src/diagnostics.ts`.
- [ ] Call `readSubagentMetricsSummary(deps.goblinHome)` in `gatherDiagnostics`.
- [ ] Render subagent metrics in `formatDiagnostics` after the existing `Subagents` line.
- [ ] Update `src/diagnostics.test.ts` to assert `/debug` output contains subagent totals, latency, tokens, cost, and cache.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 3: surface subagent metrics in /debug`

## Phase 4: Validate and finalize

- [ ] Run `bun run typecheck` and `bun test` for the full change.
- [ ] Run `litespec validate subagent-metrics` and fix any issues.
- [ ] Review `specs/changes/subagent-metrics/` for consistency with `session-metrics` and the source files.
- [ ] Commit: `phase 4: validate subagent metrics change`

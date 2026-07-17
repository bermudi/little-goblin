# Session Metrics Tasks

## Phase 1: Add metrics module and session file layout

- [x] Create `src/metrics/store.ts` with `MetricsStore`, `MetricsEvent`, `MetricsSummary`, and `readMetricsSummary`.
- [x] Create `src/metrics/mod.ts` barrel exporting `MetricsStore`, `MetricsEvent`, `MetricsSummary`, and `readMetricsSummary`.
- [x] Add `metricsPath(home, id)` to `src/sessions/paths.ts` (uses `sessionDir` and `validateSessionId`).
- [x] Update `ensureSessionFiles` in `src/sessions/manager.ts` to create an empty `metrics.jsonl`.
- [x] Add `src/metrics/store.test.ts` covering `record`, `incrementCounter`, `readMetricsSummary`, missing file, append, and invalid session id.
- [x] Run `bun run typecheck` and `bun test`.
- [x] Commit: `phase 1: add metrics module and session metrics.jsonl layout`

## Phase 2: Record turn metrics from AgentRunner

- [x] Add `metrics: MetricsStore` private field and public getter to `AgentRunner` in `src/agent/mod.ts`.
- [x] Construct `MetricsStore` in `AgentRunner` constructor and pass it to `MemoryStore` and `MemoryReflector` (optional `metrics` parameter; no-op if not consumed yet).
- [x] Track turn start timestamp and tool counts in `handleEvent`, and record a `turn` event on assistant `message_end`.
- [x] Update `src/agent/mod.ts` tests to assert `turn` events are written to `metrics.jsonl`.
- [x] Run `bun run typecheck` and `bun test`.
- [x] Commit: `phase 2: record turn metrics in AgentRunner`

## Phase 3: Instrument memory writes, searches, and reflection

- [x] Add optional `metrics` constructor parameter to `MemoryStore` in `src/memory/store.ts` and record write/overflow/safety-reject counters.
- [x] Add optional `metrics` constructor parameter to `MemoryReflector` in `src/memory/reflector.ts` and record candidate/persisted/quarantine counters.
- [x] Add optional `metrics` parameter to `searchMemoryEntries` in `src/memory/search.ts` and record `memory_search` events.
- [x] Add optional `metrics` parameter to `formatSnapshot` in `src/memory/snapshot.ts` and record `snapshot_built` events.
- [x] Update `AgentRunner` to pass `this.metrics` into `MemoryStore`, `MemoryReflector`, `searchMemoryEntries`, and `formatSnapshot`.
- [x] Add tests for memory counter and event recording in `src/memory/store.test.ts`, `reflector.test.ts`, `search.test.ts`, and `snapshot.test.ts` as appropriate.
- [x] Run `bun run typecheck` and `bun test`.
- [x] Commit: `phase 3: instrument memory writes, search, reflection, and snapshot`

## Phase 4: Surface metrics in `/debug`

- [x] Extend `Diagnostics` in `src/diagnostics.ts` with `metrics: MetricsSummary | null`.
- [x] Call `readMetricsSummary` in `gatherDiagnostics` and render last turn, totals, memory counters, and cache summary in `formatDiagnostics`.
- [x] Update `src/diagnostics.test.ts` to assert `/debug` output contains metrics fields.
- [x] Run `bun run typecheck` and `bun test`.
- [x] Commit: `phase 4: surface session metrics in /debug`

## Phase 5: Validate and finalize

- [x] Run `bun run typecheck` and `bun test` for the full change.
- [x] Run `litespec validate session-metrics` and fix any issues.
- [x] Review `specs/changes/session-metrics/` for consistency with the implementation.
- [x] Commit: `phase 5: validate session metrics change`

## Phase 6: Address initial review findings

- [x] Fix `AgentRunner` `turnStart` fallback to preserve the `prompt()` start time when `agent_start` or `turn_start` events lack a timestamp.
- [x] Fix `MetricsStore.record` to use the counter lock for counter events.
- [x] Extend `/debug` "Last turn" output with `usage.totalTokens`, `cost`, `cacheRead`, `cacheWrite`, `stopReason`, and `errorMessage`.
- [x] Route metrics imports through the `src/metrics/mod.ts` barrel file.
- [x] Add missing tests for tool error counts, `snapshot_built` metric events, and quarantine counter values.
- [x] Run `bun run typecheck`, `bun test`, and `litespec validate session-metrics`.
- [x] Commit: `phase 6: fix session-metrics review findings` and `fix: address review findings for session-metrics`

## Phase 7: Address pre-archive review findings

- [x] Dispose the runner and await in-flight memory reflection before archiving the session directory.
- [x] Create an empty `metrics.jsonl` body before the first `MetricsStore` append.
- [x] Count `procedural_noise` candidates in `memory_reflection_quarantine_total`.
- [x] Add tests locking empty-snapshot and zero-result-search metric behavior.
- [x] Align agent delta spec wording with the `turn_end` metric event behavior.
- [x] Mark ADR `0014-metrics-file-location` as accepted.
- [x] Run `bun run typecheck`, `bun test`, and `litespec validate session-metrics`.
- [x] Commit: `fix: address pre-archive review findings for session-metrics`

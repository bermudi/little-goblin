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

- [ ] Add `metrics: MetricsStore` private field and public getter to `AgentRunner` in `src/agent/mod.ts`.
- [ ] Construct `MetricsStore` in `AgentRunner` constructor and pass it to `MemoryStore` and `MemoryReflector` (optional `metrics` parameter; no-op if not consumed yet).
- [ ] Track turn start timestamp and tool counts in `handleEvent`, and record a `turn` event on assistant `message_end`.
- [ ] Update `src/agent/mod.ts` tests to assert `turn` events are written to `metrics.jsonl`.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 2: record turn metrics in AgentRunner`

## Phase 3: Instrument memory writes, searches, and reflection

- [ ] Add optional `metrics` constructor parameter to `MemoryStore` in `src/memory/store.ts` and record write/overflow/safety-reject counters.
- [ ] Add optional `metrics` constructor parameter to `MemoryReflector` in `src/memory/reflector.ts` and record candidate/persisted/quarantine counters.
- [ ] Add optional `metrics` parameter to `searchMemoryEntries` in `src/memory/search.ts` and record `memory_search` events.
- [ ] Add optional `metrics` parameter to `formatSnapshot` in `src/memory/snapshot.ts` and record `snapshot_built` events.
- [ ] Update `AgentRunner` to pass `this.metrics` into `MemoryStore`, `MemoryReflector`, `searchMemoryEntries`, and `formatSnapshot`.
- [ ] Add tests for memory counter and event recording in `src/memory/store.test.ts`, `reflector.test.ts`, `search.test.ts`, and `snapshot.test.ts` as appropriate.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 3: instrument memory writes, search, reflection, and snapshot`

## Phase 4: Surface metrics in `/debug`

- [ ] Extend `Diagnostics` in `src/diagnostics.ts` with `metrics: MetricsSummary | null`.
- [ ] Call `readMetricsSummary` in `gatherDiagnostics` and render last turn, totals, memory counters, and cache summary in `formatDiagnostics`.
- [ ] Update `src/commands/registry.test.ts` and `src/diagnostics.test.ts` to assert `/debug` output contains metrics fields.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 4: surface session metrics in /debug`

## Phase 5: Validate and finalize

- [ ] Run `bun run typecheck` and `bun test` for the full change.
- [ ] Run `litespec validate session-metrics` and fix any issues.
- [ ] Review `specs/changes/session-metrics/` for consistency with the implementation.
- [ ] Commit: `phase 5: validate session metrics change`

# Telegram Metrics Tasks

## Phase 1: Extend `metrics` module with Telegram events and aggregation

- [x] Add `telegram` variant to `MetricsEvent` in `src/metrics/store.ts`.
- [x] Extend `MetricsSummary` to include `telegram` counts and update `readMetricsSummary` to aggregate `telegram` events and `telegram_*` counters.
- [x] Update `src/metrics/mod.ts` to export the new `telegram` event type and updated `MetricsSummary` type.
- [x] Add `src/metrics/store.test.ts` cases for `telegram` event recording, `readMetricsSummary` aggregation, and counter+event combination.
- [x] Run `bun run typecheck` and `bun test src/metrics/`.
- [x] Commit: `phase 1: extend metrics with telegram event and summary aggregation`

## Phase 2: Instrument `MessageBuffer` and system-reply path

- [ ] Add optional `metrics` to `MessageBufferOptions` and store it in `MessageBuffer`.
- [ ] Record `telegram` events for `sendMessage`/`editMessageText` calls in `flushStatus`, `flushResponse`, `maybeRollover`, and plain-text retry paths.
- [ ] Record `telegram` `throttled` events in `flushResponse`/`flushStatus` short-circuits.
- [ ] Extend `handleApiError` to classify and record `telegram` outcomes and increment `telegram_topic_not_found_total`.
- [ ] Update `src/tg/intake.ts` `createMessageBuffer` factory to accept `SessionState` and create a session-scoped `MetricsStore`.
- [ ] Extend `src/orchestration/dispatcher.ts` `createMessageBuffer` signature to pass `SessionState` to the factory.
- [ ] Update `src/bot.ts` to wrap `TelegramIntakeMessage.reply` with `telegram` `sendMessage` event recording.
- [ ] Update `src/tg/buffer.test.ts` and `src/bot.test.ts` (or `src/tg/format.test.ts`) to assert `telegram` events are recorded.
- [ ] Run `bun run typecheck` and `bun test src/tg/ src/bot.test.ts`.
- [ ] Commit: `phase 2: instrument message buffer and system replies with telegram metrics`

## Phase 3: Surface Telegram metrics in `/debug`

- [ ] Extend `formatDiagnostics` in `src/diagnostics.ts` to render `MetricsSummary.telegram` counts.
- [ ] Update `src/diagnostics.test.ts` and `src/commands/registry.test.ts` to assert `/debug` output includes Telegram send/edit/throttled/rate-limited/topic-not-found counts.
- [ ] Run `bun run typecheck` and `bun test src/diagnostics/ src/commands/`.
- [ ] Commit: `phase 3: surface telegram metrics in debug`

## Phase 4: Validate and finalize

- [ ] Run `bun run typecheck` and `bun test` for the full change.
- [ ] Run `litespec validate telegram-metrics` and fix any issues.
- [ ] Review `specs/changes/telegram-metrics/` for consistency with the implementation.
- [ ] Commit: `phase 4: validate telegram metrics change`

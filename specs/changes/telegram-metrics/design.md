# Telegram Metrics Design

## Architecture

This change extends the `session-metrics` `MetricsStore` foundation with Telegram-specific events and counters, then wires the two places that talk to the Telegram API: `MessageBuffer` (status/response `sendMessage`/`editMessageText`) and the system-reply path (`ctx.reply` used by `sendSystemReply`). The `/debug` command reads the aggregated `MetricsSummary.telegram` counts through the existing `readMetricsSummary` seam.

### Data flow

1. **`MessageBuffer` records per-call `telegram` events** (`src/tg/buffer.ts`):
   - `flushStatus` and `flushResponse` record a `telegram` event for every `sendMessage`/`editMessageText` call with `op`, `channel` (`status`/`response`), and `outcome`.
   - Local throttle short-circuits record a `telegram` event with `op: null` and `outcome: "throttled"`.
   - `handleApiError` classifies errors and records `outcome: "rate_limited"`, `"topic_not_found"`, `"message_gone"`, `"message_not_modified"`, or `"error"`.
   - `MessageBuffer` receives its `MetricsStore` from the `createMessageBuffer` factory, scoped to the active session.

2. **`createMessageBuffer` factory passes `MetricsStore`** (`src/tg/intake.ts`):
   - The factory creates a session-scoped `MetricsStore` and passes it into the `MessageBuffer` constructor.
   - `TurnDispatcher.createMessageBuffer` is extended to accept the current `SessionState` so the factory does not have to re-resolve the session from `isSupergroup`-ambiguous `ChatLocator` data.

3. **System replies record `sendMessage` events** (`src/bot.ts`):
   - `intakeMessageFromCtx` resolves the `SessionState` for the incoming message and builds a `TelegramIntakeMessage.reply` wrapper around `ctx.reply`.
   - Each `ctx.reply` attempt (including the Markdown-then-plain retry inside `sendSystemReply`) records a `telegram` event with `op: "sendMessage"` and `channel: "system"`.

4. **`metrics` module aggregates Telegram events** (`src/metrics/store.ts`):
   - `MetricsEvent` union gains a `telegram` variant.
   - `readMetricsSummary` scans `telegram` events and `telegram_*` counters and returns `MetricsSummary.telegram` with `sendTotal`, `sendSuccess`, `sendError`, `editTotal`, `editSuccess`, `editError`, `messageNotModified`, `messageGone`, `throttled`, `rateLimited`, and `topicNotFound`.

5. **`/debug` surfaces Telegram counts** (`src/diagnostics.ts`):
   - `gatherDiagnostics` already calls `readMetricsSummary`; `formatDiagnostics` renders the `telegram` section when `metrics` is non-null.

## Decisions

### `MessageBuffer` records telemetry directly at the API call sites

- **Chosen**: `MessageBuffer` records a `telegram` event inside `flushStatus`, `flushResponse`, `maybeRollover`, and the plain-text retry paths, right around the `sendMessage`/`editMessageText` calls.
- **Why**: This is the only place that knows whether a call was a `sendMessage` or `editMessageText` and whether it was for the status or response channel. Wrapping `bot.api` globally would lose the channel distinction and would make per-session `MetricsStore` wiring awkward.
- **Trade-off**: `MessageBuffer` gains a `metrics` dependency. It only records when `metrics` is provided, so unit tests without a `MetricsStore` continue to work.

### `TelegramIntakeMessage.reply` wrapper records system-reply metrics

- **Chosen**: `src/bot.ts` wraps the `ctx.reply` callback that becomes `TelegramIntakeMessage.reply` and records `telegram` events there.
- **Why**: `sendSystemReply` is in `src/tg/format.ts` and is used by `intake.ts` tests with a fake `{ reply: ... }`. Modifying `sendSystemReply` to accept a `MetricsStore` would require changing every call site and every test. Wrapping the callback in `bot.ts` (the composition root) records all system-reply traffic without touching `format.ts`.
- **Trade-off**: `bot.ts` now resolves the session to build a `MetricsStore` for each message. Resolution is cheap and the `MetricsStore` is lazy (it only touches disk on the first `record`/`incrementCounter` call).

### `TurnDispatcher` passes the `SessionState` to the `createMessageBuffer` factory

- **Chosen**: `TurnDispatcher.createMessageBuffer` becomes `createMessageBuffer(locator, session?)` and the `createMessageBuffer` factory in `src/tg/intake.ts` accepts the optional `session`.
- **Why**: The factory needs the session id to create a session-scoped `MetricsStore`. Re-resolving the `ChatLocator` to a `SessionState` inside the factory is possible but requires trying `isSupergroup: true`/`false` fallbacks and risks creating a spurious supergroup session for a DM with no active session. Passing the session is explicit and safe.
- **Trade-off**: `src/orchestration/dispatcher.ts` changes its internal factory-call signature, but the dispatcher's public behavior (transport-agnostic, obtains sink through injected factory) is unchanged.

### `MetricsStore` instances are stateless and safe to create per turn/per message

- **Chosen**: `MessageBuffer` and `TelegramIntakeMessage.reply` each get their own `MetricsStore` for the same session.
- **Why**: `MetricsStore` opens `metrics.jsonl` in append mode for each write and does not keep an open file descriptor or in-memory cache. Two instances with the same `sessionId` append to the same file without coordination.
- **Trade-off**: Slightly more `fs.openSync` calls; acceptable for the current per-session write volume.

### `telegram` events are primary; `telegram_*` counters are optional

- **Chosen**: `MessageBuffer` and the reply wrapper record `telegram` events per call. `readMetricsSummary` aggregates the events. Callers may also use `incrementCounter` for `telegram_*` counters, and `readMetricsSummary` combines them.
- **Why**: Per-call events preserve the timeline and error context (error code, description, retry-after). Counters are convenient for quick totals and backward-compatible with `incrementCounter`. Combining both lets callers choose either or both.
- **Trade-off**: `readMetricsSummary` scans all `telegram` events to produce counts. Per-session `metrics.jsonl` for Telegram traffic is expected to be small (tens to hundreds of lines per session).

## File Changes

### Modified files

- `src/metrics/store.ts`
  - Add `telegram` variant to the `MetricsEvent` union.
  - Extend `MetricsSummary` to include `telegram` counts.
  - Update `readMetricsSummary` to aggregate `telegram` events and `telegram_*` counters.
  - Relates to metrics spec `MetricsEvent types include Telegram transport events` and `MetricsSummary aggregates Telegram API outcomes`.

- `src/metrics/mod.ts`
  - Re-export the `telegram` event type and the updated `MetricsSummary` type.
  - Relates to metrics spec `MetricsEvent types include Telegram transport events`.

- `src/metrics/store.test.ts`
  - Add tests for `telegram` event recording, `readMetricsSummary` aggregation, and `telegram_*` counter handling.
  - Relates to all metrics spec scenarios.

- `src/tg/buffer.ts`
  - Add optional `metrics` to `MessageBufferOptions` and store it in the class.
  - Record `telegram` events for `sendMessage`/`editMessageText` calls in `flushStatus`, `flushResponse`, `maybeRollover`, and plain-text retries.
  - Record `telegram` `throttled` events when `flushResponse`/`flushStatus` short-circuits on the throttle window.
  - Extend `handleApiError` to classify outcomes and record `telegram` events (including `topic_not_found`). `readMetricsSummary` derives `topicNotFound` from `topic_not_found` events and can still combine any separately-recorded `telegram_topic_not_found_total` counter values.
  - Relates to telegram spec `MessageBuffer records Telegram API call metrics`, `MessageBuffer records response and status throttling`, and `MessageBuffer receives a session-scoped MetricsStore`.

- `src/tg/buffer.test.ts`
  - Add tests asserting `telegram` events are recorded for success, 429, topic-not-found, throttle, and message-not-modified.

- `src/tg/intake.ts`
  - Update `createMessageBuffer` factory to accept an optional `SessionState` and create a `MetricsStore` for it.
  - Pass `session` to `dispatcher.createMessageBuffer` in `scheduleFreshTurn` and `runPrompt`.
  - Relates to telegram spec `MessageBuffer receives a session-scoped MetricsStore`.

- `src/orchestration/dispatcher.ts`
  - Extend `TurnDispatcherOptions.createMessageBuffer` type to `CreateMessageBufferFn` with optional `session`.
  - Update `TurnDispatcher.createMessageBuffer` to accept and forward the `SessionState`.
  - Update `enqueueScheduledTurn` to pass `session` to `createMessageBuffer`.
  - Relates to telegram spec `MessageBuffer receives a session-scoped MetricsStore`.

- `src/bot.ts`
  - In `intakeMessageFromCtx`, resolve the active `SessionState` and wrap `ctx.reply` with a closure that records `telegram` `sendMessage` events to the session's `MetricsStore`.
  - Relates to telegram spec `System replies record sendMessage metrics`.

- `src/diagnostics.ts`
  - Extend `formatDiagnostics` to render `MetricsSummary.telegram` counts.
  - Relates to commands spec `Debug command dumps diagnostics`.

- `src/diagnostics.test.ts` and `src/commands/registry.test.ts`
  - Assert `/debug` output includes the Telegram metrics section.
  - Relates to commands spec `Debug command dumps diagnostics`.

### No new files

This change extends existing `session-metrics` and Telegram layer files; it does not introduce new source modules.

# Telegram Metrics

## Motivation

`session-metrics` adds a per-session `metrics.jsonl` and a `MetricsStore` for turn and memory observability, but the Telegram transport layer is still a blind spot. There is no visibility into whether `sendMessage`/`editMessageText` calls succeed, how often response flushes are throttled, how many `topic not found` errors occur, or what the overall `MessageBuffer` API outcome counts are for a session. When a user reports "Goblin didn't respond" or a topic disappears, `/debug` cannot distinguish a Telegram API failure, a local throttle, a deleted topic, or a missing session.

This change extends the `MetricsStore` conventions with Telegram-specific events and counters, instruments `MessageBuffer` and the system-reply path, and surfaces the result in `/debug`.

## Scope

### `telegram` capability

- `MessageBuffer` records a `telegram` `MetricsEvent` for every `sendMessage` and `editMessageText` call it makes, with `op`, `channel` (`status`, `response`, `system`), and `outcome` (`success`, `error`, `rate_limited`, `topic_not_found`, `message_gone`, `message_not_modified`).
- `MessageBuffer` records `telegram` throttled events when `flushResponse`/`flushStatus` skip a flush because of the local throttle window.
- `MessageBuffer` records `telegram` `topic_not_found` events when Telegram returns a topic/thread-not-found 400.
- `MessageBuffer` accepts a `MetricsStore` via `MessageBufferOptions`; the `createMessageBuffer` factory in `src/tg/intake.ts` creates the session-scoped `MetricsStore` and passes it.
- The `TelegramIntakeMessage.reply` wrapper in `src/bot.ts` records `telegram` `sendMessage` events for system replies (including the plain-text retry path inside `sendSystemReply`).

### `metrics` capability

- Extend the `MetricsEvent` union with a `telegram` variant (`op`, `channel`, `outcome`, optional `errorCode`, `errorDescription`, `retryAfterSec`, `elapsedMs`, `throttleMs`).
- Extend `readMetricsSummary` to aggregate `telegram` events into `MetricsSummary.telegram` counts: `sendTotal`, `sendSuccess`, `sendError`, `editTotal`, `editSuccess`, `editError`, `messageNotModified`, `messageGone`, `throttled`, `rateLimited`, `topicNotFound`.
- Keep `incrementCounter` available for callers that want cumulative `telegram_*` counters (e.g. `telegram_response_throttled_total`); `readMetricsSummary` SHALL combine both `telegram` events and `telegram_*` counters.

### `commands` capability

- Extend `/debug` (`src/diagnostics.ts`) to render the Telegram API metrics from `MetricsSummary.telegram` when a session has `metrics.jsonl`.
- `gatherDiagnostics` already reads `MetricsSummary` via `readMetricsSummary`; `formatDiagnostics` adds a Telegram section such as `Telegram sends: 12 (1 failed), edits: 45 (0 failed), throttled: 3, rate-limited: 1, topic not found: 0`.

### Assumption

This change builds on the `MetricsStore` foundation defined by `session-metrics`. It does not re-create the core `metrics` module or `metrics.jsonl` persistence; it extends those conventions for Telegram-specific events.

## Non-Goals

- No new `/metrics` command; only the existing `/debug` surface is extended.
- No Prometheus, OTel, or external metrics backend.
- No instrumentation of `sendChatAction`, `sendVoice`, `sendPhoto`, or `sendDocument` (these are out of scope; the `sendMessage` summary message that follows a file escape is covered as a `sendMessage`).
- No modifications to `session-metrics` planning artifacts.
- No per-message or per-chat dashboards; aggregation remains per-session.

# metrics

## ADDED Requirements

### Requirement: MetricsEvent types include Telegram transport events

The `MetricsEvent` union SHALL include a `telegram` variant. A `telegram` event SHALL have `type: "telegram"`, `op` (`"sendMessage"` | `"editMessageText"` | `null`), `channel` (`"status"` | `"response"` | `"system"`), `outcome` (`"success"` | `"error"` | `"rate_limited"` | `"topic_not_found"` | `"message_gone"` | `"message_not_modified"` | `"throttled"`), optional `errorCode` (number), optional `errorDescription` (string), optional `retryAfterSec` (number), optional `elapsedMs` (number), and optional `throttleMs` (number). `MetricsStore.record` SHALL accept `telegram` events and append them as one JSONL line.

#### Scenario: Record a successful sendMessage response event

- **WHEN** `metrics.record({ type: "telegram", op: "sendMessage", channel: "response", outcome: "success" })` is called
- **THEN** a single JSONL line containing those fields SHALL be appended to `metrics.jsonl`

#### Scenario: Record a throttled response flush

- **WHEN** `metrics.record({ type: "telegram", op: null, channel: "response", outcome: "throttled", elapsedMs: 123, throttleMs: 1100 })` is called
- **THEN** a single JSONL line containing those fields SHALL be appended to `metrics.jsonl`

#### Scenario: Record a topic-not-found event

- **WHEN** `metrics.record({ type: "telegram", op: "editMessageText", channel: "response", outcome: "topic_not_found", errorCode: 400, errorDescription: "Topic not found" })` is called
- **THEN** a single JSONL line containing those fields SHALL be appended to `metrics.jsonl`

### Requirement: MetricsSummary aggregates Telegram API outcomes

`MetricsSummary` SHALL include a `telegram` object with `sendTotal`, `sendSuccess`, `sendError`, `editTotal`, `editSuccess`, `editError`, `messageNotModified`, `messageGone`, `throttled`, `rateLimited`, and `topicNotFound` (all numbers). `readMetricsSummary` SHALL compute these from `telegram` events and `telegram_*` counters:

- `sendTotal` SHALL be the count of `telegram` events with `op === "sendMessage"`.
- `sendSuccess` SHALL be the count of `sendMessage` events with `outcome === "success"`.
- `sendError` SHALL be the count of `sendMessage` events whose `outcome` is `error`, `rate_limited`, `topic_not_found`, or `message_gone`.
- `editTotal` SHALL be the count of `telegram` events with `op === "editMessageText"`.
- `editSuccess` SHALL be the count of `editMessageText` events with `outcome === "success"`.
- `editError` SHALL be the count of `editMessageText` events whose `outcome` is `error`, `rate_limited`, `topic_not_found`, or `message_gone`.
- `messageNotModified` SHALL be the count of `editMessageText` events with `outcome === "message_not_modified"`.
- `messageGone` SHALL be the count of `editMessageText` events with `outcome === "message_gone"`.
- `throttled` SHALL be the count of `telegram` events with `outcome === "throttled"`.
- `rateLimited` SHALL be the count of `telegram` events with `outcome === "rate_limited"`.
- `topicNotFound` SHALL be the count of `telegram` events with `outcome === "topic_not_found"`.

If `readMetricsSummary` returns `null` (missing `metrics.jsonl`), all Telegram fields SHALL be unavailable. If the file is empty or contains no `telegram` events or `telegram_*` counters, the `telegram` object SHALL contain zeros.

#### Scenario: Summary with mixed Telegram events

- **WHEN** `metrics.jsonl` contains one `sendMessage` success, one `editMessageText` `error`, and one `throttled` response event
- **THEN** `readMetricsSummary` SHALL return `telegram.sendTotal: 1`, `telegram.sendSuccess: 1`, `telegram.editTotal: 1`, `telegram.editError: 1`, and `telegram.throttled: 1`

#### Scenario: Summary with no Telegram events

- **WHEN** `metrics.jsonl` exists but contains only `turn` and `counter` events
- **THEN** `readMetricsSummary` SHALL return `telegram` with all fields set to `0`

### Requirement: MetricsStore supports Telegram counter names

`MetricsStore.incrementCounter` SHALL accept `telegram_*` counter names such as `telegram_send_message_total`, `telegram_send_message_success_total`, `telegram_send_message_error_total`, `telegram_edit_message_total`, `telegram_edit_message_success_total`, `telegram_edit_message_error_total`, `telegram_response_throttled_total`, and `telegram_topic_not_found_total`. `readMetricsSummary` SHALL read the last recorded value for each `(name, scope)` and treat the sum of the last values across all scopes as the current value for that counter name, then combine the totals with the `telegram` event counts for the `telegram` summary fields.

#### Scenario: Counter-only Telegram metrics

- **WHEN** `metrics.jsonl` contains `counter` events `telegram_send_message_total: 5` (scope `response`) and `telegram_send_message_success_total: 4` (scope `response`)
- **THEN** `readMetricsSummary` SHALL return `telegram.sendTotal: 5` and `telegram.sendSuccess: 4`

#### Scenario: Counters and events combine

- **WHEN** `metrics.jsonl` contains a `telegram_send_message_total` counter of `3` and a `telegram` event with `op: "sendMessage"`, `outcome: "success"`
- **THEN** `readMetricsSummary` SHALL return `telegram.sendTotal: 4` and `telegram.sendSuccess: 4`

# telegram

## ADDED Requirements

### Requirement: MessageBuffer records Telegram API call metrics

The `MessageBuffer` class in `src/tg/buffer.ts` SHALL accept an optional `metrics` `MetricsStore` in `MessageBufferOptions`. When `metrics` is present, every `sendMessage` and `editMessageText` call made by `MessageBuffer` (status placeholder, status edits, response sends, response edits, rollover sends/edits, plain-text retry sends/edits, and the summary `sendMessage` after a file escape) SHALL record a `telegram` `MetricsEvent` describing the call.

- `op` SHALL be `"sendMessage"` for `sendMessage` calls and `"editMessageText"` for `editMessageText` calls.
- `channel` SHALL be `"status"` for status-line operations and `"response"` for response-bubble operations.
- `outcome` SHALL be:
  - `"success"` when the API call resolves without throwing;
  - `"rate_limited"` when Telegram returns `error_code: 429`;
  - `"topic_not_found"` when the 400 description matches the topic/thread-not-found pattern;
  - `"message_gone"` when the 400 description matches the message-not-found/cannot-be-edited pattern;
  - `"message_not_modified"` when the 400 description matches "message is not modified";
  - `"error"` for all other failures.
- Non-success outcomes SHALL include `errorCode` and `errorDescription` in the event.

The `topic_not_found` outcome is recorded through the `telegram` event above; `readMetricsSummary` derives `topicNotFound` from `topic_not_found` events (and can still combine any separately-recorded `telegram_topic_not_found_total` counter values).

#### Scenario: Status placeholder send succeeds

- **WHEN** `flushStatus` calls `sendMessage` and the API resolves
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "status"`, `outcome: "success"` SHALL be appended to `metrics.jsonl`

#### Scenario: Response edit is rate-limited

- **WHEN** `flushResponse` calls `editMessageText` and Telegram returns 429 with `retry_after`
- **THEN** a `telegram` event with `op: "editMessageText"`, `channel: "response"`, `outcome: "rate_limited"` and `retryAfterSec` SHALL be recorded
- **AND** the buffer's `lastResponseEditTime` SHALL be advanced by the retry interval

#### Scenario: Topic not found during response edit

- **WHEN** `flushResponse` calls `editMessageText` and Telegram returns a 400 matching topic not found
- **THEN** a `telegram` event with `op: "editMessageText"`, `channel: "response"`, `outcome: "topic_not_found"` SHALL be recorded
- **AND** `readMetricsSummary` for the session SHALL report `topicNotFound: 1`

#### Scenario: Response send hits a MarkdownV2 parse error and retries as plain text

- **WHEN** `flushResponse` calls `sendMessage` with `parse_mode: "MarkdownV2"` and Telegram returns a 400 parse error
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "response"`, `outcome: "error"`, `errorCode: 400`, and `errorDescription` containing parse SHALL be recorded
- **AND** the buffer SHALL retry the same text as plain text
- **AND** the retry `sendMessage` SHALL record a `success` event when it resolves

### Requirement: MessageBuffer records response and status throttling

When `MessageBuffer.flushResponse` or `MessageBuffer.flushStatus` short-circuits because the elapsed time since the last edit is less than the configured throttle window, the buffer SHALL record a `telegram` `MetricsEvent` with `op: null`, `channel` set to `"status"` or `"response"`, `outcome: "throttled"`, and top-level `elapsedMs` and `throttleMs` fields.

#### Scenario: Response flush is throttled

- **WHEN** `flushResponse` is called while `now - lastResponseEditTime < responseThrottleMs`
- **THEN** a `telegram` event with `op: null`, `channel: "response"`, `outcome: "throttled"`, `elapsedMs`, and `throttleMs` SHALL be recorded
- **AND** no `sendMessage` or `editMessageText` call SHALL be made for that flush

#### Scenario: Status flush is throttled

- **WHEN** `flushStatus` is called while `now - lastEditTime < statusThrottleMs`
- **THEN** a `telegram` event with `op: null`, `channel: "status"`, `outcome: "throttled"`, `elapsedMs`, and `throttleMs` SHALL be recorded

### Requirement: MessageBuffer receives a session-scoped MetricsStore

`MessageBufferOptions` SHALL include an optional `metrics` field of type `MetricsStore`. The `createMessageBuffer` factory in `src/tg/intake.ts` SHALL create a `MetricsStore` scoped to the `SessionState` resolved for the `ChatLocator` and pass it to the `MessageBuffer` constructor. The `TurnDispatcher` SHALL pass the current `SessionState` to `createMessageBuffer` when it creates a turn sink so the factory can build the `MetricsStore` without re-resolving the session.

#### Scenario: Active session MessageBuffer has a MetricsStore

- **WHEN** `createMessageBuffer` is called for a session with id `abc123`
- **THEN** the returned `MessageBuffer` SHALL have `metrics` scoped to `state/sessions/abc123/metrics.jsonl`
- **AND** all Telegram API calls from that buffer SHALL append to that session's `metrics.jsonl`

#### Scenario: No session yields no MetricsStore

- **WHEN** `createMessageBuffer` is called with no `SessionState` and no session can be resolved for the locator
- **THEN** the returned `MessageBuffer` SHALL have no `metrics`
- **AND** it SHALL operate without recording telemetry

### Requirement: System replies record sendMessage metrics

`src/bot.ts` SHALL wrap `ctx.reply` in `TelegramIntakeMessage.reply` with a closure that records a `telegram` `MetricsEvent` for every `sendMessage` attempt (including the plain-text retry inside `sendSystemReply`). Each system-reply `sendMessage` attempt SHALL record `op: "sendMessage"`, `channel: "system"`, and `outcome` (`success` or the failure outcome). The wrapper SHALL NOT throw or crash if the `MetricsStore` is unavailable or recording fails.

#### Scenario: sendSystemReply succeeds

- **WHEN** `sendSystemReply` calls `message.reply` with Markdown and `ctx.reply` resolves
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "system"`, `outcome: "success"` SHALL be recorded

#### Scenario: sendSystemReply parse error and retry

- **WHEN** `sendSystemReply` calls `message.reply` with Markdown and `ctx.reply` throws a 400 parse error
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "system"`, `outcome: "error"`, `errorCode: 400`, and `errorDescription` containing parse SHALL be recorded
- **AND** the plain-text retry `sendMessage` SHALL record a `success` event when it resolves

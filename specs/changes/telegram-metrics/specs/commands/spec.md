# commands

## MODIFIED Requirements

### Requirement: Debug command dumps diagnostics

The `/debug` command is instant-timing: it runs immediately regardless of streaming state and does not abort or defer the current turn. It SHALL include the session name, the session metrics (turn, memory, cache) as specified in `session-metrics`, and SHALL additionally render Telegram API metrics from `MetricsSummary.telegram` when a session has a `metrics.jsonl`.

`gatherDiagnostics` SHALL read `metrics.jsonl` via `readMetricsSummary` and add `metrics: MetricsSummary | null` to the `Diagnostics` snapshot. `formatDiagnostics` SHALL render the Telegram API metrics as a section such as `Telegram sends: <sendTotal> (<sendError> failed), edits: <editTotal> (<editError> failed), throttled: <throttled>, rate-limited: <rateLimited>, topic not found: <topicNotFound>`, using `0` for any unavailable count when `metrics` is null. When `metrics` is null, the output SHALL include `Metrics: unavailable`.

#### Scenario: Named session with Telegram metrics

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` contains one `sendMessage` success, one `sendMessage` error, one `editMessageText` success, and one `throttled` event
- **THEN** the output SHALL contain `Telegram sends: 2 (1 failed), edits: 1 (0 failed), throttled: 1, rate-limited: 0, topic not found: 0`

#### Scenario: Session with no metrics file

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` is missing
- **THEN** the output SHALL contain `Metrics: unavailable`

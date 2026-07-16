# commands

## MODIFIED Requirements

### Requirement: Debug command dumps diagnostics

The `/debug` command is instant-timing: it runs immediately regardless of streaming state and does not abort or defer the current turn. It SHALL include the session name and the session's `metrics.jsonl` output as defined by `session-metrics`. In addition, `/debug` SHALL include a voice/ASR/TTS section when voice/ASR/TTS metrics are present.

`gatherDiagnostics` SHALL read the session's `metrics.jsonl` via `readMetricsSummary` and include `asrSummary`, `ttsSummary`, and `voiceSummary` in the `Diagnostics` type. `formatDiagnostics` SHALL render the following lines when the summaries are present and non-null:

- `ASR: <asrRequests> requests (<asrSuccess> ok, <asrFailure> fail), avg <asrAvgDurationMs>ms, total <asrTotalBytes> bytes`
- `TTS: <ttsRequests> requests (<ttsSuccess> ok, <ttsFailure> fail), avg <ttsAvgDurationMs>ms, total <ttsTotalOutputSize> bytes`
- `Voice: <voiceReceived> received, <voiceSaved> saved, <voiceSent> sent, <voiceErrors> errors, total <voiceTotalDuration>s, <voiceTotalFileSize> bytes`
- `Audio processing errors: <audioProcessingErrors>`

When the `metrics.jsonl` file is missing or empty, the `formatDiagnostics` output SHALL include `Voice/ASR: unavailable` and omit the detailed lines.

#### Scenario: Session with voice and ASR activity

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` contains one successful ASR request, one successful TTS request, and one received voice message
- **THEN** the output SHALL contain `ASR: 1 requests (1 ok, 0 fail)` and `TTS: 1 requests (1 ok, 0 fail)`
- **AND** it SHALL contain `Voice: 1 received, 0 saved, 0 sent, 0 errors`

#### Scenario: Session with no metrics file

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` is missing
- **THEN** the output SHALL contain `Voice/ASR: unavailable`

#### Scenario: Session with ASR failures

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` contains one successful and one failed ASR request
- **THEN** the output SHALL contain `ASR: 2 requests (1 ok, 1 fail)`

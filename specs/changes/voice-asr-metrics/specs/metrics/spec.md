# metrics

## ADDED Requirements

### Requirement: `MetricsEvent` union includes `asr`, `tts`, and `voice` event types

The `MetricsStore` SHALL accept `asr`, `tts`, and `voice` events via `record`. The `MetricsEvent` union SHALL contain at least:

- `asr` — `start` (ISO timestamp), `end` (ISO timestamp), `durationMs` (number), `model` (string), `provider` (string), `mimeType` (string), `byteSize` (number), `ok` (boolean), `textLength` (number | null), `errorMessage` (string | null).
- `tts` — `start` (ISO timestamp), `end` (ISO timestamp), `durationMs` (number), `voiceName` (string), `textLength` (number), `ok` (boolean), `outputSize` (number | null), `errorMessage` (string | null).
- `voice` — `kind` ("received" | "saved" | "sent" | "error"), `ts` (ISO timestamp), `mimeType` (string | null), `fileSize` (number | null), `duration` (number | null), `savedName` (string | null), `phase` ("download" | "size" | "save" | "send" | "setup" | null), `errorMessage` (string | null).

The existing `turn`, `counter`, and `event` types from `session-metrics` SHALL remain unchanged.

#### Scenario: Record an `asr` event

- **WHEN** `record({ type: "asr", start: "...", end: "...", durationMs: 1234, model: "whisper-large-v3-turbo", provider: "groq", mimeType: "audio/ogg", byteSize: 12000, ok: true, textLength: 5, errorMessage: null })` is called
- **THEN** a JSON line containing the event is appended to `metrics.jsonl`

#### Scenario: Record a `tts` event

- **WHEN** `record({ type: "tts", start: "...", end: "...", durationMs: 2000, voiceName: "en-US-EmmaMultilingualNeural", textLength: 11, ok: true, outputSize: 12000, errorMessage: null })` is called
- **THEN** a JSON line containing the event is appended to `metrics.jsonl`

#### Scenario: Record a `voice` received event

- **WHEN** `record({ type: "voice", kind: "received", ts: "...", mimeType: "audio/ogg", fileSize: 12000, duration: 5, savedName: null, phase: null, errorMessage: null })` is called
- **THEN** a JSON line containing the event is appended to `metrics.jsonl`

### Requirement: `readMetricsSummary` returns voice/ASR/TTS summary

`readMetricsSummary` SHALL parse the session's `metrics.jsonl` and return `asrSummary`, `ttsSummary`, and `voiceSummary` fields in addition to the fields defined by `session-metrics`. For each category, it SHALL compute counts and totals from the `asr`, `tts`, and `voice` event types, and fall back to `counter` events for `*_request_total`, `*_success_total`, and `*_failure_total` if no event is present. It SHALL return `null` when the file is missing or unreadable and SHALL skip malformed lines.

The summary SHALL include at least:

- `asrSummary`: `asrRequests`, `asrSuccess`, `asrFailure`, `asrTotalDurationMs`, `asrAvgDurationMs`, `asrTotalBytes`, `lastAsrTextLength`, `lastAsrDurationMs`.
- `ttsSummary`: `ttsRequests`, `ttsSuccess`, `ttsFailure`, `ttsTotalDurationMs`, `ttsAvgDurationMs`, `ttsTotalTextLength`, `ttsTotalOutputSize`, `lastTtsDurationMs`.
- `voiceSummary`: `voiceReceived`, `voiceSaved`, `voiceSent`, `voiceErrors`, `voiceTotalDuration`, `voiceTotalFileSize`, `audioProcessingErrors`.

#### Scenario: Summary of a populated voice metrics file

- **WHEN** `readMetricsSummary(home, sessionId)` is called and `metrics.jsonl` contains one `asr` success, one `tts` success, and one `voice` `received` event
- **THEN** `asrSummary.asrRequests` SHALL be 1, `asrSuccess` SHALL be 1, `asrFailure` SHALL be 0, `asrTotalBytes` SHALL equal the event's `byteSize`, and `asrAvgDurationMs` SHALL equal the event's `durationMs`
- **AND** `ttsSummary.ttsRequests` SHALL be 1, `ttsSuccess` SHALL be 1, `ttsFailure` SHALL be 0, `ttsTotalOutputSize` SHALL equal the event's `outputSize`
- **AND** `voiceSummary.voiceReceived` SHALL be 1, `voiceSaved` SHALL be 0, `voiceSent` SHALL be 0, and `voiceTotalFileSize` SHALL equal the event's `fileSize`

#### Scenario: Missing metrics file

- **WHEN** `readMetricsSummary(home, sessionId)` is called and `metrics.jsonl` does not exist
- **THEN** it SHALL return `null`

#### Scenario: Malformed metrics lines are skipped

- **WHEN** `readMetricsSummary` reads a `metrics.jsonl` with one valid `asr` event and one malformed line
- **THEN** the summary SHALL be computed from the valid line only and no exception is thrown

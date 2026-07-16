# asr

## ADDED Requirements

### Requirement: `transcribeWithGroq` records ASR metrics

`transcribeWithGroq` in `src/asr/groq.ts` SHALL accept an optional `metrics` field in `AsrInput`. When `metrics` is provided, `transcribeWithGroq` SHALL record an `asr` event and increment ASR counters. The `asr` event SHALL include `start` (ISO timestamp), `end` (ISO timestamp), `durationMs`, `model`, `provider` (set to `"groq"`), `mimeType`, `byteSize`, `ok`, `textLength` (when `ok` is true), and `errorMessage` (when `ok` is false). `transcribeWithGroq` SHALL increment `asr_request_total` once per call and `asr_success_total` or `asr_failure_total` based on the result.

#### Scenario: Successful transcription

- **WHEN** `transcribeWithGroq` is called with `metrics` and returns `{ ok: true, text: "hello" }` for 12,000 bytes of `audio/ogg`
- **THEN** an `asr` event is recorded with `ok: true`, `textLength: 5`, `byteSize: 12000`, `mimeType: "audio/ogg"`, `durationMs` greater than or equal to 0, and `provider: "groq"`
- **AND** `asr_request_total` and `asr_success_total` counters are incremented

#### Scenario: Empty transcript is success

- **WHEN** `transcribeWithGroq` returns `{ ok: true, text: "" }` and `metrics` is provided
- **THEN** an `asr` event is recorded with `ok: true` and `textLength: 0`
- **AND** `asr_success_total` is incremented

#### Scenario: API error

- **WHEN** `transcribeWithGroq` returns `{ ok: false, error: "Groq ASR request failed (HTTP 429)." }` and `metrics` is provided
- **THEN** an `asr` event is recorded with `ok: false` and the sanitized `errorMessage`
- **AND** `asr_failure_total` is incremented

#### Scenario: Network/timeout error

- **WHEN** the Groq request times out and `transcribeWithGroq` returns `{ ok: false, error: "Groq ASR request timed out after 30s." }` with `metrics` provided
- **THEN** an `asr` event is recorded with `ok: false` and `errorMessage` indicating the timeout
- **AND** `asr_failure_total` is incremented

### Requirement: `handleVoice` passes `MetricsStore` to ASR

`handleVoice` in `src/tg/intake.ts` SHALL pass the runner's `MetricsStore` to `transcribeWithGroq` via the `metrics` field of `AsrInput` so that ASR metrics are recorded in the current session.

#### Scenario: Voice message transcribed with metrics

- **WHEN** `handleVoice` processes a voice message for a session with a runner
- **THEN** `transcribeWithGroq` is called with `metrics` set to `runner.metrics`
- **AND** the resulting `asr` event is written to the session's `metrics.jsonl`

#### Scenario: Missing Groq key still records an attempt

- **WHEN** `handleVoice` is invoked but `cfg.groqApiKey` is missing
- **THEN** no `asr` event is recorded because no transcription request was made
- **AND** a `voice` `error` event with `phase: "setup"` is recorded

# voice

## ADDED Requirements

### Requirement: `edgeTts` records TTS metrics

`edgeTts` in `src/voice.ts` SHALL accept an optional `metrics` parameter (a `MetricsStore` instance). When `metrics` is provided, `edgeTts` SHALL record a `tts` event and increment `tts` counters. The `tts` event SHALL include `start` (ISO timestamp), `end` (ISO timestamp), `durationMs`, `voiceName`, `textLength`, `ok`, `outputSize` (byte size of the generated MP3 when successful), and `errorMessage` (when `ok` is false). `edgeTts` SHALL increment `tts_request_total` once per call and `tts_success_total` or `tts_failure_total` based on the result.

#### Scenario: Successful TTS

- **WHEN** `edgeTts("hello world", voiceName, outputPath, { metrics })` succeeds and produces a 12,000 byte MP3
- **THEN** a `tts` event is appended with `ok: true`, `textLength: 11`, `outputSize: 12000`, and `durationMs` greater than or equal to 0
- **AND** `tts_request_total` and `tts_success_total` counters are incremented

#### Scenario: Failed TTS

- **WHEN** `edgeTts` fails and `metrics` is provided
- **THEN** a `tts` event is appended with `ok: false` and an `errorMessage`
- **AND** `tts_request_total` and `tts_failure_total` counters are incremented

### Requirement: `text_to_speech` tool records TTS metrics

`createTextToSpeechTool` in `src/tg/tools.ts` SHALL accept an optional `metrics` parameter and pass it to `edgeTts`. When the tool is invoked, the `tts` metrics SHALL be recorded for the generated audio.

#### Scenario: Tool succeeds with metrics

- **WHEN** `createTextToSpeechTool({ metrics })` is invoked and the text is successfully converted to speech
- **THEN** a `tts` event is recorded with `ok: true`, `textLength`, and `outputSize`

### Requirement: `send_voice` tool records voice send metrics

`createSendVoiceTool` in `src/tg/tools.ts` SHALL accept an optional `metrics` parameter. When the tool sends a voice file, it SHALL record a `voice` event with `kind: "sent"`, `mimeType`, and `fileSize`. On failure, it SHALL record a `voice` event with `kind: "error"` and `phase: "send"`.

#### Scenario: Successful send

- **WHEN** `send_voice` sends a file of 12,000 bytes and `metrics` is provided
- **THEN** a `voice` event with `kind: "sent"`, `fileSize: 12000`, and `mimeType` is recorded

#### Scenario: Send fails

- **WHEN** `send_voice` fails due to a Telegram API error and `metrics` is provided
- **THEN** a `voice` event with `kind: "error"` and `phase: "send"` is recorded

### Requirement: `createBetaTools` provides a session `MetricsStore` to voice tools

`createBetaTools` in `src/tg/intake.ts` SHALL receive the session id from `TurnDispatcher` and create a `MetricsStore` bound to `state/sessions/<id>/metrics.jsonl`. It SHALL pass that `MetricsStore` to `createTextToSpeechTool` and `createSendVoiceTool`. `TurnDispatcher.createRunner` in `src/orchestration/dispatcher.ts` SHALL pass `session.id` to `createBetaTools` when building tools for a runner.

#### Scenario: Runner creation wires voice tools to session metrics

- **WHEN** `TurnDispatcher.createRunner` is called for a session
- **THEN** `createBetaTools` is invoked with the session id
- **AND** `createTextToSpeechTool` and `createSendVoiceTool` receive a `MetricsStore` bound to that session

### Requirement: `executeVoice` command records TTS and send metrics

`executeVoice` in `src/commands/voice.ts` SHALL accept an optional `metrics` parameter. It SHALL record a `tts` event by passing `metrics` to `edgeTts`, and record a `voice` `sent` event after the Telegram `sendVoice` succeeds. On failure, it SHALL record a `voice` `error` event with `phase: "send"`.

#### Scenario: `/voice` succeeds

- **WHEN** `executeVoice` is called with `metrics` and the assistant message is converted to voice and sent
- **THEN** a `tts` event and a `voice` `sent` event are recorded

#### Scenario: `/voice` TTS fails

- **WHEN** `executeVoice` is called with `metrics` and `edgeTts` fails
- **THEN** a `tts` event with `ok: false` is recorded and no `voice` `sent` event is recorded

### Requirement: `handleVoice` records received voice metadata and errors

`handleVoice` in `src/tg/intake.ts` SHALL use the runner's `MetricsStore` to record a `voice` event with `kind: "received"` when the voice file is downloaded, including `mimeType`, `fileSize`, and `duration` when available from the Telegram voice metadata. When the file is saved to a project directory, it SHALL record a `voice` event with `kind: "saved"` and `savedName`. On download, size, or save failure, it SHALL record a `voice` event with `kind: "error"` and a `phase` of `"download"`, `"size"`, or `"save"`.

#### Scenario: Voice message downloaded

- **WHEN** `handleVoice` downloads a voice message with `mimeType: "audio/ogg"`, `duration: 5`, and 12,000 bytes
- **THEN** a `voice` event with `kind: "received"`, `mimeType: "audio/ogg"`, `fileSize: 12000`, and `duration: 5` is recorded

#### Scenario: Voice message saved to project

- **WHEN** `handleVoice` saves the voice file as `voice-123.oga` to the project directory
- **THEN** a `voice` event with `kind: "saved"` and `savedName: "voice-123.oga"` is recorded

#### Scenario: Voice file too large

- **WHEN** `downloadFileBytes` returns null because the voice file exceeds `MAX_FILE_BYTES`
- **THEN** a `voice` event with `kind: "error"` and `phase: "size"` is recorded

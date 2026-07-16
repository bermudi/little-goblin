# Voice/ASR Metrics

## Motivation

The `session-metrics` change introduces a per-session `metrics.jsonl` and a typed `MetricsStore` for turn, memory, and reflection observability. The voice/audio pipeline — Telegram voice downloads, Groq ASR, Microsoft Edge TTS, and Telegram voice sends — currently has no comparable visibility. Operators cannot see ASR latency or failure rate, TTS latency or failure rate, voice file sizes/durations, or where audio processing fails (download too large, save error, etc.).

This change extends the `MetricsStore` conventions with `asr`, `tts`, and `voice` event types and instruments the voice/audio pipeline so that `/debug` can report voice/ASR metrics per session.

## Scope

This change touches four capabilities: `voice` (modified), `asr` (modified), `metrics` (extended), and `commands` (modified).

### `voice` capability

- Extend `edgeTts` in `src/voice.ts` to accept an optional `MetricsStore` and record a `tts` event with `start`, `end`, `durationMs`, `voiceName`, `textLength`, `ok`, `outputSize`, and `errorMessage`.
- Extend `executeVoice` in `src/commands/voice.ts` to accept an optional `MetricsStore`, record the `tts` event via `edgeTts`, and record a `voice` `sent` event after the Telegram send.
- Extend `createTextToSpeechTool` and `createSendVoiceTool` in `src/tg/tools.ts` to accept an optional `MetricsStore` and record `tts` and `voice` `sent` events respectively.
- Extend `createBetaTools` in `src/tg/intake.ts` to receive the session id from `TurnDispatcher` and create a session-scoped `MetricsStore` to pass to the voice/TTS tools.
- Extend `handleVoice` in `src/tg/intake.ts` to record `voice` `received` events (file size, duration, MIME type), `voice` `saved` events (when saved to a project directory), and `voice` `error` events for download, size, and save failures.

### `asr` capability

- Extend `AsrInput` in `src/asr/groq.ts` with an optional `metrics` field.
- Extend `transcribeWithGroq` to record an `asr` event with `start`, `end`, `durationMs`, `model`, `provider`, `mimeType`, `byteSize`, `ok`, `textLength`, and `errorMessage` when a `MetricsStore` is provided.
- Extend `handleVoice` in `src/tg/intake.ts` to pass the runner's `MetricsStore` into `transcribeWithGroq`.

### `metrics` capability

- Extend the `MetricsEvent` union with `asr`, `tts`, and `voice` event types.
- Extend `readMetricsSummary` to aggregate and return `asrSummary`, `ttsSummary`, and `voiceSummary` fields (request counts, success/failure counts, average latency, total bytes, total duration, etc.).
- Keep `MetricsStore.record` and `incrementCounter` generic; the new event types are just additional members of the union.

### `commands` capability

- Extend `/debug` (`src/diagnostics.ts`) to read the voice/ASR/TTS summary from `readMetricsSummary` and render it in the diagnostics output.
- `/debug` remains instant-timing and reads metrics from disk.

## Non-Goals

- No new `/voice_metrics` or `/asr` command.
- No Prometheus/OTel exporter, no real-time streaming, no alerting, no cross-session dashboard.
- No changes to `session-metrics` itself (the `metrics` module is extended by the new event types, not rewritten).
- No per-user or per-chat aggregation beyond the existing per-session `metrics.jsonl`.
- No changes to the `transcript.jsonl` schema or to the Groq/TTS provider output schemas.
- No voice/ASR metrics in the live runner UI beyond `/debug`.

## Scope Note

This change is a vertical slice: the voice/audio pipeline emits metrics, the `metrics` module can summarize them, and `/debug` displays them. It is intentionally kept as one change because the instrumentation and the debug surface are coupled by the same event schema.

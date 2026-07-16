# Voice/ASR Metrics Design

## Architecture

The `session-metrics` change introduces a per-session `MetricsStore` and `metrics.jsonl`. This change extends that foundation to the voice/audio pipeline: it defines `asr`, `tts`, and `voice` `MetricsEvent` shapes, instruments the `asr` provider, TTS utility, Telegram voice handlers, and voice tools, and surfaces the aggregates in `/debug`.

### Data flow

1. **ASR recording** (`src/asr/groq.ts` and `src/tg/intake.ts`):
   - `handleVoice` already has the runner's `MetricsStore` from `session-metrics` (via `runner.metrics`).
   - `handleVoice` passes `runner.metrics` into `transcribeWithGroq` via the `metrics` field of `AsrInput`.
   - `transcribeWithGroq` records an `asr` event with `start`, `end`, `durationMs`, `model`, `provider`, `mimeType`, `byteSize`, `ok`, `textLength`, and `errorMessage`, and increments `asr_request_total` and `asr_success_total`/`asr_failure_total` counters.
2. **Voice file recording** (`src/tg/intake.ts` `handleVoice`):
   - After a successful download, `handleVoice` records a `voice` `received` event with `mimeType`, `fileSize`, and `duration` (from Telegram metadata).
   - After a successful project save, it records a `voice` `saved` event with `savedName`.
   - On download, size, or save failure, it records a `voice` `error` event with `phase` and `errorMessage`.
3. **TTS recording** (`src/voice.ts` and `src/tg/tools.ts`):
   - `edgeTts` accepts an optional `MetricsStore` and records a `tts` event with `start`, `end`, `durationMs`, `voiceName`, `textLength`, `ok`, `outputSize`, and `errorMessage`, plus `tts_request_total` and `tts_success_total`/`tts_failure_total` counters.
   - `createTextToSpeechTool` receives a `MetricsStore` from `createBetaTools` and passes it to `edgeTts`.
   - `executeVoice` in `src/commands/voice.ts` passes a `MetricsStore` to `edgeTts` and records a `voice` `sent` event after the Telegram send.
4. **Voice send recording** (`src/tg/tools.ts`):
   - `createSendVoiceTool` receives a `MetricsStore` from `createBetaTools` and records `voice` `sent` events on successful sends and `voice` `error` events on send failures.
5. **Metrics aggregation** (`src/metrics/store.ts`):
   - `MetricsStore.record` accepts the new `asr`, `tts`, and `voice` event types because it is typed over the `MetricsEvent` union.
   - `readMetricsSummary` aggregates the new event types into `asrSummary`, `ttsSummary`, and `voiceSummary`.
6. **Debug surface** (`src/diagnostics.ts`):
   - `gatherDiagnostics` reads `metrics.jsonl` through `readMetricsSummary` and includes the new summaries.
   - `formatDiagnostics` renders the voice/ASR/TTS section when metrics are present.

## Decisions

### `asr`, `tts`, and `voice` are first-class `MetricsEvent` types

- **Chosen**: Extend `MetricsEvent` with separate `asr`, `tts`, and `voice` types rather than generic `event` entries.
- **Why**: Strongly typed event shapes make `readMetricsSummary` easier to implement and keep the `metrics.jsonl` stream self-describing. The generic `event` type is still available for ad-hoc instrumentation.
- **Trade-off**: The `MetricsEvent` union grows; the `metrics` module must import the new types, but `asr`/`voice` do not need to import `metrics` if they are passed an instance.

### `MetricsStore` is injected into the ASR and voice tools

- **Chosen**: `transcribeWithGroq`, `edgeTts`, `createTextToSpeechTool`, and `createSendVoiceTool` accept an optional `MetricsStore` parameter. Callers that have a store (the runner, `handleVoice`, `executeVoice`, `createBetaTools`) pass it; callouts without one behave as before.
- **Why**: The `asr` and `voice` modules are leaf providers and should not own a `MetricsStore` lifecycle. Optional injection preserves the existing seams and makes the modules testable without a real `MetricsStore`.
- **Trade-off**: A few function signatures need an optional `metrics` argument. The tool factories are created before `AgentRunner` is fully initialized, so `createBetaTools` creates the session `MetricsStore` from `cfg.goblinHome` and the session id.

### `createBetaTools` receives the session id and creates a `MetricsStore` for the voice tools

- **Chosen**: `TurnDispatcher.createRunner` passes `session.id` to `createBetaTools`. `createBetaTools` creates a `MetricsStore` and passes it to `createTextToSpeechTool` and `createSendVoiceTool`.
- **Why**: The tool factories are constructed in the Telegram layer before `AgentRunner` is available, but they still need a session-scoped metrics writer. Passing the session id is the smallest change that preserves the existing `TurnDispatcher`/`AgentRunner` separation.
- **Trade-off**: There are now two `MetricsStore` instances per session in memory (one created by `AgentRunner` for turn/memory, one created by `createBetaTools` for voice tools). Both append to the same `metrics.jsonl` and `MetricsStore` is stateless, so this is safe and avoids a larger `AgentRunner` refactor.

### Counters are cumulative alongside typed events

- **Chosen**: `asr`, `tts`, and voice error paths increment cumulative `counter` events (`asr_request_total`, `tts_success_total`, `audio_processing_error_total`, etc.) in addition to recording typed events.
- **Why**: Cumulative counters make the `/debug` summary resilient to missing or malformed events; the last counter value is the current total. Typed events carry latency, size, and duration details.
- **Trade-off**: `metrics.jsonl` grows one extra line per counter. This is acceptable for the current per-session volume.

### `readMetricsSummary` derives aggregates from events, with counters as fallback

- **Chosen**: `readMetricsSummary` counts `asr`/`tts`/`voice` events and sums their fields to produce the summary. If no event of a type is present, it falls back to the last `*_request_total`, `*_success_total`, or `*_failure_total` counter.
- **Why**: This lets callers get a complete summary even if one instrumented path only records counters, while still preserving rich per-event data from the instrumented paths.
- **Trade-off**: `readMetricsSummary` must scan the entire file. For the expected per-session size this is fine; if `metrics.jsonl` grows large, compaction can be added later.

## File Changes

### New files

- `src/metrics/types.ts` (optional) — if `store.ts` becomes too large, extract `MetricsEvent` and `MetricsSummary` types here. Relates to `metrics` spec `MetricsEvent union includes asr, tts, and voice event types`.

### Modified files

- `src/metrics/store.ts`
  - Extend `MetricsEvent` union with `asr`, `tts`, and `voice` types.
  - Extend `MetricsSummary` and `readMetricsSummary` to return `asrSummary`, `ttsSummary`, and `voiceSummary`.
  - Relates to `metrics` spec `MetricsEvent union includes asr, tts, and voice event types` and `readMetricsSummary returns voice/ASR/TTS summary`.

- `src/metrics/store.test.ts`
  - Add tests for `asr`/`tts`/`voice` event recording and `readMetricsSummary` aggregation.
  - Relates to `metrics` spec scenarios.

- `src/asr/groq.ts`
  - Add optional `metrics` field to `AsrInput`.
  - Record `asr` events and `asr_*_total` counters around the Groq request.
  - Relates to `asr` spec `transcribeWithGroq records ASR metrics`.

- `src/asr/groq.test.ts`
  - Add tests for `asr` event recording on success, empty text, API failure, and timeout.
  - Relates to `asr` spec scenarios.

- `src/voice.ts`
  - Add optional `metrics` parameter to `edgeTts`.
  - Record `tts` events and `tts_*_total` counters.
  - Relates to `voice` spec `edgeTts records TTS metrics`.

- `src/voice.test.ts`
  - Add tests for `tts` event recording and counter increments.
  - Relates to `voice` spec `edgeTts records TTS metrics`.

- `src/tg/tools.ts`
  - `createTextToSpeechTool` accepts `metrics` and passes it to `edgeTts`.
  - `createSendVoiceTool` accepts `metrics` and records `voice` `sent`/`error` events.
  - Relates to `voice` spec `text_to_speech tool records TTS metrics` and `send_voice tool records voice send metrics`.

- `src/tg/tools.test.ts`
  - Add tests for `tts` and `voice` sent event recording in the tools.
  - Relates to `voice` spec tool scenarios.

- `src/tg/intake.ts`
  - `createBetaTools` receives `sessionId` and creates a `MetricsStore` for the voice tools.
  - `handleVoice` records `voice` `received`/`saved`/`error` events and passes `runner.metrics` to `transcribeWithGroq`.
  - Relates to `voice` spec `createBetaTools provides a session MetricsStore to voice tools`, `handleVoice records received voice metadata and errors`, and `asr` spec `handleVoice passes MetricsStore to ASR`.

- `src/tg/intake.test.ts`
  - Add tests for `voice` received/saved/error events and `asr` event passing.
  - Relates to `voice` and `asr` spec scenarios.

- `src/orchestration/dispatcher.ts`
  - `TurnDispatcher.createRunner` passes `session.id` to `createBetaTools`.
  - Relates to `voice` spec `createBetaTools provides a session MetricsStore to voice tools`.

- `src/commands/voice.ts`
  - `executeVoice` accepts `metrics` and records `tts` and `voice` `sent` events.
  - Relates to `voice` spec `executeVoice command records TTS and send metrics`.

- `src/commands/voice.test.ts`
  - Add tests for `executeVoice` metrics recording.
  - Relates to `voice` spec `executeVoice command records TTS and send metrics`.

- `src/commands/registry.ts`
  - `voiceHandler` passes `existingRunner?.metrics` or constructs a `MetricsStore` to `executeVoice`.
  - Relates to `voice` spec `executeVoice command records TTS and send metrics`.

- `src/diagnostics.ts`
  - Add `asrSummary`, `ttsSummary`, and `voiceSummary` to the `Diagnostics` type.
  - `gatherDiagnostics` calls `readMetricsSummary` and includes the new summaries.
  - `formatDiagnostics` renders the voice/ASR/TTS section.
  - Relates to `commands` spec `Debug command dumps diagnostics`.

- `src/diagnostics.test.ts`
  - Add tests for `/debug` output containing voice/ASR/TTS lines.
  - Relates to `commands` spec scenarios.

### No changes needed

- `src/agent/mod.ts` — `AgentRunner` already exposes `metrics` from `session-metrics`; it is consumed by `handleVoice` and `createBetaTools` without further `AgentRunner` changes.
- `src/sessions/paths.ts` — `metricsPath` is added by `session-metrics`; this change reuses it.
- `src/sessions/manager.ts` — `metrics.jsonl` creation and archive are handled by `session-metrics`.
- `src/bot.ts` — no new wiring; `createTelegramIntake` and `registerCommands` remain unchanged.

## Cross-cutting rule flagged

The `metrics` delta and `voice`/`asr` deltas both depend on the `MetricsEvent` union and the `MetricsStore` API introduced by `session-metrics`. This change extends `session-metrics` without modifying it. The `MetricsStore` is intentionally stateless, so the two instances per session (one from `AgentRunner`, one from `createBetaTools`) safely share the same `metrics.jsonl`.

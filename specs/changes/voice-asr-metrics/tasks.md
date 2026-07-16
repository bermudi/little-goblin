# Voice/ASR Metrics Tasks

## Phase 1: Extend metrics module with voice/ASR/TTS event types

- [ ] Extend `MetricsEvent` in `src/metrics/store.ts` with `asr`, `tts`, and `voice` types.
- [ ] Extend `MetricsSummary` and `readMetricsSummary` in `src/metrics/store.ts` to return `asrSummary`, `ttsSummary`, and `voiceSummary`.
- [ ] Add `src/metrics/store.test.ts` tests covering `asr`, `tts`, and `voice` event recording and summary aggregation.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 1: extend metrics module with voice/asr/tts event types`

## Phase 2: Instrument ASR

- [ ] Add optional `metrics` field to `AsrInput` in `src/asr/groq.ts`.
- [ ] Record `asr` events and `asr_*_total` counters in `transcribeWithGroq`.
- [ ] Update `src/asr/groq.test.ts` to assert `asr` event recording for success, empty text, API failure, and timeout.
- [ ] Update `src/tg/intake.ts` `handleVoice` to pass `runner.metrics` to `transcribeWithGroq`.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 2: instrument Groq ASR with metrics`

## Phase 3: Instrument TTS

- [ ] Add optional `metrics` parameter to `edgeTts` in `src/voice.ts` and record `tts` events and `tts_*_total` counters.
- [ ] Update `src/voice.test.ts` to assert `tts` event recording.
- [ ] Update `createTextToSpeechTool` in `src/tg/tools.ts` to accept `metrics` and pass it to `edgeTts`.
- [ ] Update `src/tg/tools.test.ts` to assert `tts` event recording.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 3: instrument TTS with metrics`

## Phase 4: Wire voice tools to session metrics and instrument voice sends

- [ ] Extend `createSendVoiceTool` in `src/tg/tools.ts` to accept `metrics` and record `voice` `sent`/`error` events.
- [ ] Extend `createBetaTools` in `src/tg/intake.ts` to receive `sessionId` and create a `MetricsStore` to pass to `createTextToSpeechTool` and `createSendVoiceTool`.
- [ ] Update `TurnDispatcher.createRunner` in `src/orchestration/dispatcher.ts` to pass `session.id` to `createBetaTools`.
- [ ] Update `src/tg/tools.test.ts` and `src/tg/intake.test.ts` for the new signatures.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 4: wire voice tools to session metrics and instrument sends`

## Phase 5: Instrument voice file handling and `/voice` command

- [ ] Update `handleVoice` in `src/tg/intake.ts` to record `voice` `received`, `saved`, and `error` events.
- [ ] Update `executeVoice` in `src/commands/voice.ts` to accept `metrics` and record `tts` and `voice` `sent` events.
- [ ] Update `voiceHandler` in `src/commands/registry.ts` to pass `existingRunner?.metrics` or a fresh `MetricsStore` to `executeVoice`.
- [ ] Update `src/tg/intake.test.ts` and `src/commands/voice.test.ts` for voice event recording.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 5: instrument voice file handling and /voice command`

## Phase 6: Surface voice/ASR/TTS metrics in `/debug`

- [ ] Extend `Diagnostics` in `src/diagnostics.ts` with `asrSummary`, `ttsSummary`, and `voiceSummary`.
- [ ] Call `readMetricsSummary` in `gatherDiagnostics` and assign the new summary fields.
- [ ] Render the voice/ASR/TTS section in `formatDiagnostics`.
- [ ] Update `src/diagnostics.test.ts` to assert `/debug` output contains voice/ASR/TTS lines.
- [ ] Run `bun run typecheck` and `bun test`.
- [ ] Commit: `phase 6: surface voice/asr/tts metrics in /debug`

## Phase 7: Validate and finalize

- [ ] Run `bun run typecheck` and `bun test` for the full change.
- [ ] Run `litespec validate voice-asr-metrics` and fix any issues.
- [ ] Review `specs/changes/voice-asr-metrics/` for consistency with the implementation.
- [ ] Commit: `phase 7: validate voice-asr-metrics change`

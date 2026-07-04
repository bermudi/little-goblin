# telegram-voice-asr tasks

## Phase 1: Add ASR config

- [ ] Add `groqApiKey` and `asrModel` to `src/schema.ts` for `Groq ASR configuration`.
- [ ] Extend `Config` in `src/config.ts` with `groqApiKey?: string` and `asrModel`.
- [ ] Add config tests for default model, valid override, invalid model rejection, and key resolution.
- [ ] Run `bun test src/config.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 2: Add Groq transcription

- [ ] Create `src/asr/groq.ts` with typed success/failure results for `Groq ASR provider transcribes audio bytes`.
- [ ] Create `src/asr/mod.ts` as the internal ASR barrel.
- [ ] Add mocked-fetch tests for successful transcription, API failure, network failure, empty transcript, and secret redaction.
- [ ] Run `bun test src/asr/groq.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 3: Wire voice intake

- [ ] Update `handleVoice` in `src/tg/intake.ts` to call Groq ASR for `Voice intake transcribes Telegram voice messages`.
- [ ] Preserve project-file saving and saved-file prompt notes for `Voice intake preserves project file saving`.
- [ ] Keep all voice download, ASR, save, reply, and prompt work inside the existing scheduled media task for `Agent turns do not block unrelated updates`.
- [ ] Update `src/tg/intake.test.ts` for no-projectDir transcription, projectDir save+transcript, missing key, ASR failure, empty transcript, and stale-runner behavior.
- [ ] Run `bun test src/tg/intake.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 4: Refresh backlog

- [ ] Strike `specs/backlog.md` STT-provider open question line as resolved by Groq.
- [ ] Leave `backlog.md` voice-note-first (STT+TTS) item intact since TTS remains a non-goal.
- [ ] Run `litespec validate telegram-voice-asr`.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.

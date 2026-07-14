# telegram-voice-asr tasks

## Phase 1: Add ASR config

- [x] Add `groqApiKey` and `asrModel` to `src/schema.ts` for `Groq ASR configuration`.
- [x] Extend `Config` in `src/config.ts` with `groqApiKey?: string` and `asrModel`.
- [x] Add config tests for default model, valid override, invalid model rejection, and key resolution.
- [x] Run `bun test src/config.test.ts`.
- [x] Run `bun run typecheck`.

## Phase 2: Add Groq transcription

- [x] Create `src/asr/groq.ts` with typed success/failure results for `Groq ASR provider transcribes audio bytes`.
- [x] Create `src/asr/mod.ts` as the internal ASR barrel.
- [x] Add mocked-fetch tests for successful transcription, API failure, network failure, empty transcript, and secret redaction.
- [x] Run `bun test src/asr/groq.test.ts`.
- [x] Run `bun run typecheck`.

## Phase 3: Wire voice intake

- [x] Update `handleVoice` in `src/tg/intake.ts` to call Groq ASR for `Voice intake transcribes Telegram voice messages`.
- [x] Preserve project-file saving and saved-file prompt notes for `Voice intake preserves project file saving`.
- [x] Keep all voice download, ASR, save, reply, and prompt work inside the existing scheduled media task for `Agent turns do not block unrelated updates`.
- [x] Update `src/tg/intake.test.ts` for no-projectDir transcription, projectDir save+transcript, missing key, ASR failure, empty transcript, and stale-runner behavior.
- [x] Run `bun test src/tg/intake.test.ts`.
- [x] Run `bun run typecheck`.

## Phase 4: Refresh backlog

- [x] Strike `specs/backlog.md` STT-provider open question line as resolved by Groq.
- [x] Leave `backlog.md` voice-note-first (STT+TTS) item intact since TTS remains a non-goal.
- [x] Run `litespec validate telegram-voice-asr`.
- [x] Run `bun test`.
- [x] Run `bun run typecheck`.

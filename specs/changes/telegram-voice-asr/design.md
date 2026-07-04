# telegram-voice-asr design

## Architecture

Voice ASR fits into the existing Telegram intake seam. `src/bot.ts` continues to be a thin grammy adapter: it extracts `voice.file_id` and `voice.mime_type`, builds a `TelegramIntakeMessage`, and delegates to `createTelegramIntake(...).handleVoice(...)`. The ASR work happens inside the scheduled media task created by `handleVoice`, so the Telegram update handler still returns without waiting for download, transcription, saving, or agent prompting.

Data flow:

1. `handleVoice` resolves the active turn using the existing `resolveActiveTurn` helper.
2. The work is scheduled through the active session's existing prompt queue.
3. The scheduled work downloads bytes with the existing `downloadFileBytes(...)` helper and checks `isCurrent()` after each awaited step.
4. The scheduled work calls a new ASR module with `{ audioBytes, mimeType, model, apiKey }`.
5. On successful non-empty transcript, intake builds a text prompt beginning with `[Voice message transcript]`.
6. If `projectDir` is bound, intake also saves the original voice file using the current `voice-<timestamp>.<ext>` naming behavior and includes a saved-file note in the prompt.
7. Intake prompts the runner via `runPrompt`, which preserves `message.prepare(...)` and normal `MessageBuffer` rendering.

The new ASR module is internal and provider-shaped, but only Groq is implemented. That keeps Telegram intake from knowing multipart/API details while avoiding a premature provider registry.

## Decisions

### Use Groq-only ASR behind a small interface

Chosen: create an internal ASR function such as `transcribeWithGroq(...)` plus result types in `src/asr/`.

Why: the user wants simple Groq-only behavior now, while leaving a seam for future providers. A full provider registry would add config and abstraction surface before there is a second provider.

Constraints: implementation should avoid naming generic config like `asrProvider`; the only user-facing config is Groq API key plus model choice.

Spec links: `Groq ASR provider transcribes audio bytes`, `Groq ASR configuration`.

### Transcribe voice even without `projectDir`

Chosen: voice notes become transcript prompts whether or not file saving is enabled.

Why: Telegram voice is an input modality, not just a project attachment. The current projectDir requirement blocks DM/topic voice use.

Constraints: document and audio-file behavior remains unchanged; this proposal changes only voice-note intake.

Spec links: `Voice intake transcribes Telegram voice messages`, `Intake saves documents, voice, and audio into the project directory`.

### Preserve original voice saving when `projectDir` exists

Chosen: do not replace existing project attachment behavior; augment it with transcript prompting.

Why: project-bound sessions may rely on the saved voice file being available in the workspace. Preserving the file also gives the agent/user an audit artifact if transcription is imperfect.

Constraints: saving still uses generated voice filenames, not user-provided names.

Spec links: `Voice intake preserves project file saving`.

### Return typed ASR results instead of throwing for ordinary API failures

Chosen: ASR returns a discriminated union `AsrResult = { ok: true; text: string } | { ok: false; error: string }`. Failures (`{ ok: false, error }`) cover HTTP errors, malformed JSON, missing key, and network/timeout failures. A successful HTTP response with an empty or whitespace-only `text` field is returned as `{ ok: true, text: "" }` — the endpoint succeeded, the audio just had no speech. The intake layer maps empty/whitespace `text` to the "no speech was detected" reply.

Why: voice intake needs deterministic user-facing behavior and must avoid leaking secrets in thrown error messages. Keeping the empty-text check in intake (not ASR) preserves the invariant that ASR only reports transport/API outcomes, not semantic content judgments.

Constraints: programming errors may still throw, but ordinary external-service failures should not.

Spec links: `Groq ASR provider transcribes audio bytes`, `Groq ASR setup failure does not block startup`, `Empty transcript is not prompted`.

### Keep ASR in the media prompt queue

Chosen: voice download, transcription, optional save, and prompt all stay in the same per-session prompt queue used by existing media handling.

Why: this preserves the current stale-runner guard and ordering guarantees for media messages while avoiding global update-handler blocking.

Constraints: ASR does not use `followUp`; media remains serialized even when the runner is streaming.

Spec links: `Agent turns do not block unrelated updates`, `Voice intake transcribes Telegram voice messages`.

## File Changes

### `src/schema.ts`

Add config schema fields:

- `groqApiKey: z.string().optional()`
- `asrModel: z.enum(["whisper-large-v3-turbo", "whisper-large-v3"]).default("whisper-large-v3-turbo")`

Relates to `Groq ASR configuration`.

### `src/config.ts`

Extend `Config` with `groqApiKey?: string` and `asrModel`. Populate both from parsed config. `groqApiKey` is resolved through the existing config loader's env-reference resolution (`resolveConfigValue`): if `goblin.json5` contains `groqApiKey: "GROQ_API_KEY"`, the loader resolves it from `process.env.GROQ_API_KEY` before validation. No new resolution code is needed.

Relates to `Groq ASR configuration` and `Groq ASR setup failure does not block startup`.

### `src/asr/mod.ts`

Create the ASR public barrel for internal imports. Export result/input types and the Groq transcription function.

Relates to `Groq ASR provider transcribes audio bytes`.

### `src/asr/groq.ts`

Create the Groq implementation. It builds `FormData`, attaches the Telegram voice bytes as a `Blob`, sends a bearer-token request to `https://api.groq.com/openai/v1/audio/transcriptions`, and parses a JSON `text` field.

The implementation should:

- use `AbortSignal.timeout(30_000)` (30 seconds) for bounded latency; the timeout is a hardcoded constant, not a config field, since Groq Whisper transcription of Telegram voice notes (≤20 MiB) completes well under 30s in practice;
- trim returned transcript text;
- return `{ ok: true, text: "" }` for a successful 2xx response with an empty or whitespace-only `text` field (empty text is not an ASR failure);
- return sanitized errors for non-2xx responses and malformed responses;
- never include `groqApiKey` in returned errors or logs.

Relates to `Groq ASR provider transcribes audio bytes`.

### `src/asr/groq.test.ts`

Add unit tests with mocked `fetch` for:

- successful transcription (non-empty `text`);
- empty transcript returned as `{ ok: true, text: "" }` (2xx with empty `text`);
- non-2xx response;
- network/timeout failure (including `AbortSignal.timeout` abort);
- API key not appearing in returned failure text.

Relates to all ASR scenarios.

### `src/tg/intake.ts`

Modify `handleVoice` only. Keep `resolveActiveTurn`, `turn.schedule`, `downloadFileBytes`, project file save naming, `isCurrent()` checks, and `runPrompt` patterns.

New behavior:

- download bytes before both ASR and optional saving;
- return a setup reply if `cfg.groqApiKey` is absent;
- call the ASR module with `cfg.groqApiKey`, `cfg.asrModel`, `voice.mimeType`, and downloaded bytes; if `voice.mimeType` is absent, default to `audio/ogg` (Telegram voice messages are OGG Opus by default);
- on `{ ok: false, error }`, reply that the voice message could not be transcribed (without echoing secrets);
- on `{ ok: true, text }` where `text` is empty or whitespace-only, reply that no speech was detected (intake owns the empty-text check, not ASR);
- on `{ ok: true, text }` with non-empty text, build transcript prompt for no-projectDir sessions;
- build transcript plus saved-file note for projectDir sessions.

Relates to `Voice intake transcribes Telegram voice messages`, `Voice intake preserves project file saving`, and `Agent turns do not block unrelated updates`.

### `src/tg/intake.test.ts`

Update voice tests and add coverage for:

- no projectDir + successful transcription prompts runner;
- projectDir + successful transcription saves file and includes transcript;
- missing Groq key replies with setup message;
- ASR failure replies and does not prompt;
- stale work after runner disposal does not save/reply/prompt.

Relates to Telegram and orchestration scenarios.

### `src/config.test.ts` / `src/schema` tests

Add config validation tests for default `asrModel`, valid model override, invalid model rejection, and Groq API key resolution.

Relates to `Groq ASR configuration`.

### `specs/backlog.md`

After implementation lands, strike the STT-provider open question line as resolved by Groq. Leave the voice-note-first (STT+TTS) backlog item intact since TTS remains a non-goal.

Relates to proposal hygiene rather than runtime behavior.

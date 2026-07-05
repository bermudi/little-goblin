# telegram-voice-asr

## Motivation

Telegram voice messages are currently treated as project attachments: Goblin downloads and saves them only when the active session has a bound `projectDir`, then prompts the agent with a note that a voice file was saved. Without a `projectDir`, a voice note cannot become a normal agent turn. This blocks the Telegram-native voice-note workflow already parked in the backlog.

Groq provides a fast OpenAI-compatible speech-to-text endpoint with Whisper models and a free-tier file size that is not lower than Goblin's existing Telegram download cap. Adding a small Groq-backed ASR path lets voice notes become text input without changing Goblin's single-process, Telegram-first shape.

## Scope

This change adds Groq speech-to-text for Telegram voice messages.

Affected capabilities:

- `telegram`: voice intake downloads the Telegram voice file, transcribes it, and prompts the active session with the transcript.
- `config`: Goblin accepts an optional Groq API key and ASR model setting.
- `orchestration`: media preprocessing remains non-blocking at the Telegram update-handler level and serialized through the existing per-session prompt queue.

Behavior changes:

- A Telegram voice note with an active session becomes a fresh agent turn containing a transcript.
- Voice notes no longer require a bound `projectDir` to be useful.
- When a `projectDir` is bound, Goblin preserves the current behavior of saving the original voice file and includes the saved-file note alongside the transcript.
- When Groq ASR is unavailable or fails, Goblin replies with a clear user-facing failure and does not log secrets.

New functionality:

- A small ASR module exposes a narrow provider-shaped interface while implementing only Groq for now.
- Groq transcription uses `https://api.groq.com/openai/v1/audio/transcriptions` with `whisper-large-v3-turbo` by default and `whisper-large-v3` as an optional configured model.
- Voice prompts are framed as `[Voice message transcript]` before the transcribed text so the agent can distinguish transcription text from typed text.

## Non-Goals

- No local Whisper runtime.
- No generic user-selectable ASR provider registry in this change, beyond keeping the internal interface provider-shaped for later.
- No streaming/realtime transcription.
- No diarization, timestamps, language detection UI, or transcript editing.
- No automatic TTS response.
- No changes to photo, document, or audio-file behavior beyond preserving existing shared media scheduling guarantees.

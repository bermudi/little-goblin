## Motivation

Users sometimes want to hear goblin's last response rather than read it — while driving, cooking, or just preferring audio. Telegram supports voice messages natively, and Microsoft Edge TTS provides high-quality free speech synthesis. A `/voice` (or `/v`) command that reads the last assistant message aloud makes goblin more accessible and moves toward the backlog's "v2: voice-note-first workflow."

## Scope

Two new cancel-capable commands: `/voice` and `/v`. When invoked in a chat with an active session:

1. Interrupt the current stream (same cascade-cancel semantics as `/cancel`, `/new`, etc.)
2. Read the most recent assistant message from the session's `transcript.jsonl`
3. Generate an MP3 voice file via Microsoft Edge TTS (`uvx edge-tts`)
4. Feed a synthetic prompt to the model: "User requested voice output. Audio file at `<path>`. Use `send_voice` to send it."
5. The model calls the existing `send_voice` tool with the pre-generated audio path — it does not repeat the message content and can optionally add a caption

Edge TTS is invoked as a subprocess (Python `edge-tts` package via `uvx`), not ported to TypeScript. This keeps implementation small (~50 lines of TS orchestration) and delegates protocol maintenance to the upstream library (10k+ GitHub stars).

A new `VOICE_NAME` env var selects the Edge TTS voice (default: `en-US-EmmaMultilingualNeural`).

## Non-Goals

- **No voice input (STT).** This change is output-only — text-to-speech, not speech-to-text. Voice input is the v2 backlog item and a separate change.
- **No mid-stream voice.** `/voice` interrupts the current stream first. It does not voice partial/in-progress responses.
- **No voice message splitting.** Edge TTS handles long text internally (chunked SSML). Telegram's sendVoice accepts up to 50 MB. Even goblin's `BIG_OUTPUT_THRESHOLD` (20K chars ≈ 7 MB of 48kbps MP3) stays well within limits.
- **No per-session voice preference.** Voice is configured globally via env var. Per-session or per-chat voice selection is future work.
- **No custom SSML parameters** (rate, pitch, volume). The default Edge TTS settings are used. Configurable via future env vars if needed.
- **No `send_voice` tool changes.** The existing β-tool works as-is — it accepts a file path and sends it. No modifications needed.

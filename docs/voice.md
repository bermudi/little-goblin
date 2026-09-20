# Voice

Voice works in both directions: the bot listens (transcription) and speaks
(text-to-speech). Each direction is one config block, and each can be on
without the other. Both need `ffmpeg` in the bot's `PATH`.

## Hearing you: transcription

```json5
transcription: {
  kind: "groq",
  model: "whisper-large-v3-turbo",
  auth: "groq",
},
```

With this set, every voice note, audio file, and video note is transcribed
once, when it arrives — before the model ever sees it. The transcript is
stored with the message, permanently. Models that can hear audio get the
audio; models that can't read the transcript instead of staring at a bare
file path. Either way your words are never lost.

Practical notes:

- Transcription happens in the background per topic, so a slow voice note
  never blocks other topics (or `/stop`).
- Files over the provider's 25 MB upload cap are split into 15-minute audio
  chunks, transcribed piece by piece, and joined — video notes shrink a lot
  here, since the audio track alone is a fraction of the file.
- If transcription fails (provider down, `ffmpeg` missing, corrupt file),
  the attachment stays as a file reference and the log says why. A failed
  transcript never eats your message.

## Speaking: text-to-speech

```json5
tts: { kind: "edge", voice: "en-US-AriaNeural", rate: "+0%" },
```

This uses the Edge read-aloud service: no key needed, pick any voice name
like `en-US-AriaNeural`. Two caveats, up front: it's unofficial and can
break, and `ffmpeg` must be installed (it repackages the audio into a real
Telegram voice-note bubble). A synthesis failure is always reported, never
silent — and never fails the whole reply because of it.

Three ways to hear the bot:

1. **`/voice` mode** — per topic. The reply arrives as voice notes instead
   of text: "typing…" while it thinks, "recording…" while it speaks. The
   *text* is still stored in history, so toggling `/voice` off loses
   nothing and you can always ask "what did you say verbatim". Code blocks
   and long links aren't spoken — those arrive as a plain text message next
   to the audio.
2. **The 🔊 button** — every finished text reply (when speech is configured)
   carries a 🔊 button that reads the *whole* reply aloud, not just one
   bubble. The whole-reply view comes from a small, per-process in-memory
   cache and never survives a restart. Once a reply has scrolled out of
   the cache (or after a restart), the button falls back to reading only
   the tapped bubble — the one carrying the button, so for a multi-bubble
   reply that's its last part alone. Code blocks and long URLs are left out of the button's audio too;
   the original text remains in chat.
3. **Ask for it** — "read me this document" and the bot synthesizes the
   file straight from disk (no re-typing it) and sends voice notes inline.
   Long input is split at sentence boundaries automatically.

Combine `/voice` mode with transcription and a topic becomes fully
ears-in-ears-out: voice notes in, voice notes out, full text history
underneath.

## Troubleshooting voice

| Symptom | Likely cause |
|---|---|
| `/voice` says speech isn't configured | `tts` block missing/commented in config |
| 🔊 button missing | same — no `tts`, no button |
| Voice notes arrive as files the model can't read | `transcription` not configured, or its provider was down (check the log) |
| Synthesis suddenly fails for everything | Edge endpoint changed (it's unofficial); check the log, then check for a bot update |
| `ffmpeg` warnings at boot/install | install `ffmpeg` — speech features need it |

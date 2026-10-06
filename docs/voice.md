# Voice

Voice works in both directions: the bot listens (transcription) and speaks
(text-to-speech). Transcription is opt-in; speech is on by default, but can
be turned off independently with `tts: ""`. Speech needs `ffmpeg` in the
bot's `PATH`; transcription needs it for files over the provider upload cap.

## Hearing you: transcription

```json5
transcription: {
  kind: "groq",
  model: "whisper-large-v3-turbo",
  auth: "groq",
},
```

With this set, every voice note and video note is transcribed once, when
it arrives — before the model ever sees it. The transcript is stored with
the message, permanently. Models that can hear audio get the audio;
models that can't read the transcript instead of staring at a bare file
path. Either way your words are never lost.

Attached audio is different: an mp3 or flac you *send* is a file, not a
recording — maybe a song to convert, maybe a podcast to transcribe, and
only you know which. So attached audio is never transcribed eagerly and
its bytes never go to the model; it lands in the workspace like any
other file. Ask the bot to transcribe it and the `transcribe` tool does
that, on the same provider.

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

With `tts` unset, the bot uses Edge with the default `en-US-AriaNeural`
voice. To change the voice or rate, configure it explicitly:

```json5
tts: { kind: "edge", voice: "en-US-AriaNeural", rate: "+0%" },
```

Set `tts: ""` to turn speech off. If `ffmpeg` is missing at boot, speech is
disabled for that run with a warning; install it and restart to re-enable.
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

### Speaking another language

Add `voices` to the `tts` block and the bot can pick the language per voice
note:

```json5
tts: {
  kind: "edge",
  voice: "en-US-AriaNeural",
  voices: ["es-ES-ElviraNeural", "es-MX-JorgeNeural"],
},
```

Ask "read me this in Spanish" and the speak tool picks a Spanish voice —
the language follows the voice name, and Edge reads Spanish text with a
Spanish voice natively. The choice is validated against your list: the bot
can only pick voices you configured, and an unknown name errors the tool
call so the model corrects itself.

`/voice` mode and the 🔊 button pick a matching voice from your list when
they recognize the reply's language (English or Spanish); otherwise they
use the default `voice`. A voice is a language — an English reply through
a Spanish voice comes out mangled, so the speak tool should also pick a
voice that matches the text it was given.

Combine `/voice` mode with transcription and a topic becomes fully
ears-in-ears-out: voice notes in, voice notes out, full text history
underneath.

## Troubleshooting voice

| Symptom | Likely cause |
|---|---|
| `/voice` says speech isn't available | `tts: ""` disabled it, or `ffmpeg` was missing at boot (install it and restart) |
| 🔊 button missing | same — speech is off or unavailable |
| Voice notes arrive as files the model can't read | `transcription` not configured, or its provider was down (check the log) |
| Synthesis suddenly fails for everything | Edge endpoint changed (it's unofficial); check the log, then check for a bot update |
| A voice note comes out mangled | text language and voice language don't match — Edge reads whatever text it's given with the voice's phonetics |
| `ffmpeg` warnings at boot/install | install `ffmpeg` — speech features need it |

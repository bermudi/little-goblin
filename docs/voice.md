# Voice

Voice works in both directions: the bot listens (transcription) and speaks
(text-to-speech). Transcription is opt-in; speech is on by default, but can
be turned off independently with `tts: ""`. Speech needs `ffmpeg` in the
bot's `PATH`; transcription needs it for whistle and mimo (always — it is
the wav decoder/converter), for onemin's `qwen3-asr-flash` (always —
every note transcodes to wav), and for cloud files over the provider
upload cap.

## Hearing you: transcription

The default engine is **whistle** — a small speech model that runs on the
same machine as the bot. No key, no account, and the audio never leaves
the box: the engine binary has no network code at all.

```json5
transcription: {
  kind: "whistle",
  keywords: ["goblin", "bermudi"], // optional — names it keeps misspelling
},
```

Its ~18 MB engine and weights download automatically the first time a
voice note arrives, once, into `~/goblin/cache/whistle` (digest-pinned —
upstream tampering fails loud instead of running different weights).
It understands English, German, French, Spanish, Italian, Dutch, and
Polish and auto-detects which; add `language: "es"` to pin one.

Whistle is small and local — fast and private, but its accuracy is a notch
below the big cloud models and its language list is short. Every cloud
speech API is one config flip away, with audio sent to that provider:

```json5
transcription: { kind: "groq" },        // whisper-large-v3-turbo (default)
transcription: { kind: "openai" },     // gpt-4o-mini-transcribe
transcription: { kind: "mistral" },    // voxtral
transcription: { kind: "elevenlabs" }, // scribe_v2
transcription: { kind: "gemini" },     // gemini-flash-latest
transcription: { kind: "mimo" },       // mimo-v2.5-asr, Xiaomi first-party — billed per audio hour
transcription: { kind: "openrouter", model: "elevenlabs/scribe-v2" }, // the STT catalog
transcription: { kind: "logfare" },    // whisper-large-v3-turbo; model: "nova-3" also works
transcription: { kind: "onemin" },     // 1min.AI — whisper-1 by default (see below)
```

Each kind defaults its `model` and its `auth` (the `auth.jsonl` record
name — the kind's own name). Override
either explicitly, and add `language: "es"` to skip detection (mimo's
vocabulary is narrower: `en`, `zh`, or `auto`; onemin takes an ISO code
like `es` or a locale like `en-US` — the `latest_short`/`latest_long`
models require the locale form, while `whisper-1` and `qwen3-asr-flash`
detect without it). Long
files are segmented automatically whatever the kind; openrouter warns
of ~60 s upstream processing per request, so prefer whistle or groq
for hour-long recordings.

When the primary engine can fail in a way a retry fixes — a quota, an
outage — `fallbacks` lists the backups, tried in order after the
primary throws. Settings → Voice edits the chain directly (add, order,
remove; each entry gets its own model/secret/language fields). A
produced transcript (or genuine silence) ends the chain; nothing falls
back implicitly, so whistle only runs where you place it — last, as
the free keyless safety net:

```json5
transcription: {
  kind: "groq",
  fallbacks: [
    { kind: "openrouter", model: "openai/whisper-large-v3" },
    { kind: "whistle" }, // last resort — local, no key
  ],
},
```

With transcription set, every voice note and video note is transcribed
once, when it arrives — before the model ever sees it. The transcript is
stored with the message, permanently. Models that can hear audio get the
audio; models that can't read the transcript instead of staring at a bare
file path. Either way your words are never lost.

Attached audio is different: an mp3 or flac you *send* is a file, not a
recording — maybe a song to convert, maybe a podcast to transcribe, and
only you know which. So attached audio is never transcribed eagerly and
its bytes never go to the model; it lands in the workspace like any
other file. Ask the bot to transcribe it and the `transcribe` tool does
that, on the same engine.

Practical notes:

- Transcription happens in the background per topic, so a slow voice note
  never blocks other topics (or `/stop`).
- Files over the provider's upload cap (25 MB for the cloud kinds; the
  chat-based kinds cap lower) are split into chunks, transcribed piece by
  piece, and joined — video notes shrink a lot here, since the audio
  track alone is a fraction of the file. Whistle and mimo always convert
  to 16 kHz mono wav first — whistle splits at its 30 s ceiling, mimo at
  3 minutes (sized so every request stays under its base64 cap).
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

### Cloud voices

`kind: "openrouter"` speaks through OpenRouter's text-to-speech endpoint
instead — one request shape for every speech model they route. It needs an
`openrouter` key in `auth.jsonl` and defaults to
`fish-audio/s2.1-pro-free:free`:

```json5
tts: {
  kind: "openrouter",
  model: "fish-audio/s2.1-pro-free:free", // default
  auth: "openrouter",                   // default
  voice: "b347db033a6549378b48d00acb0d06cd", // optional — Fish voice-library id
},
```

Omit `voice` to use the model's default voice. The `voices` language cast
is edge-only — upstream voice ids carry no language to match on, so one
voice speaks everything (Fish S2 is multilingual on its own). Every cloud
kind returns mp3 that must be re-encoded to ogg/opus, so the boot ffmpeg
probe additionally requires the `libopus` encoder for these kinds.

`kind: "logfare"` speaks through Logfare's speech endpoint — the same
request shape, a `logfare` key in `auth.jsonl`, and its catalog is
Deepgram Aura (`aura-2-en` by default; voice ids look like
`aura-2-asteria-en`).

```json5
tts: { kind: "logfare", model: "aura-2-en", voice: "aura-2-asteria-en" },
```

`kind: "mimo"` speaks through Xiaomi's first-party MiMo API — same
`mimo` auth record as mimo transcription. Its catalog is `mimo-v2.5-tts`
with built-in voices: `Mia`, `Chloe`, `Milo`, `Dean` for English;
`冰糖`, `茉莉`, `苏打`, `白桦` for Chinese; blank `voice` uses
`mimo_default`.

```json5
tts: { kind: "mimo", voice: "Mia" },
```

`kind: "onemin"` speaks through 1min.AI's feature API — the same
`onemin` auth record as its chat provider. TTS is its
`TEXT_TO_SPEECH` feature (`tts-1` default, also `tts-1-hd`) with the
OpenAI voices: `alloy` (the blank-voice default), `echo`, `fable`,
`onyx`, `nova`, `shimmer`. The reply chunks at 4,000 characters
(their text cap is 4,096), the result is a signed URL and the audio is
fetched from it, so a synthesis can involve a couple of round trips.

```json5
tts: { kind: "onemin", voice: "nova" },
transcription: { kind: "onemin", model: "qwen3-asr-flash" },
```

`kind: "onemin"` transcription uploads the audio to 1min's asset API
first, then runs the `SPEECH_TO_TEXT` feature and polls for the
result — the engine rides 1min's async door, so a slow transcription
polls instead of tripping the gateway. `whisper-1` (default)
auto-detects; the short/long speech models (`latest_short`,
`latest_long`) need the locale form (`language: "en-US"`);
`qwen3-asr-flash` and the elevenlabs model detect on their own
(qwen3's language list adds `fil`/`yue`). Files over the family's
published 10 MB cap segment automatically, like the other cloud
kinds. One container caveat: `qwen3-asr-flash`'s format table is the
one without MP4, and Telegram video notes arrive as MP4 — the engine
answers by routing qwen3 through 16 kHz mono wav transcodes (on every
1min model's list) while the other models keep native containers.

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

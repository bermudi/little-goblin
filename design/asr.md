# Speech recognition — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## ASR (speech → text)

Whistle (Cactus Compute) is the default engine; cloud kinds are an explicit
menu behind one interface (Engine interface). Groq stays a kind. Intake
semantics live in the model layer (`design/model.md`); this doc owns the
engine layer.

**A failed intake transcription is recorded, not silently dropped (ruling
2026-10-17).** Intake keeps the attachment — transcription is enrichment, not
intake — but records the bounded provider failure on the part for the
no-audio-modality fallback to render. A silent path-only fallback would make
the model rediscover failure with tools; the recorded reason says "your ASR
config is broken". Both intake doors populate it (tg voice/video, app
speech); a failure never mints a `transcript` field.

### Engine interface

- Empty transcript ("no speech") is the ORCHESTRATOR's null, not the
  engine's. Failures throw with the provider's name and status in the
  message; a provider outage must never read as silence (#101, unchanged).
- Auth refs resolve lazily at the point of use, like every other provider;
  resolved keys never enter logs.
- The AI SDK `transcribe()`/`TranscriptionModel` layer and `@ai-sdk/groq`
  are gone — chat never used the latter. TTS is hand-rolled the same way
  (`tts.ts`); ASR matches.

### Config

- `fallbacks` (≤4) turns the block into an ordered retry chain: the
  block's own kind first, then each entry on engine failure only — a
  produced transcript or a genuine "no speech" `null` ends the run.
  Depth is one by construction (an entry carries no fallbacks of its
  own), and a fully failed chain throws one error naming each engine,
  so the recorded `transcriptionError` keeps every link's reason. Each
  link gets the full orchestration — cap check, segmentation — so a
  wav-profile fallback (whistle, mimo) still transcodes first. The
  settings form edits the chain like the search/fetch chains — per-entry
  kind/model/auth/language plus order controls — and a save rewrites
  `goblin.json5` as the canonical parsed object (2026-10-19).
- `openrouter` is the metaprovider: its STT catalog (verified 2026-10-09)
  is one `model:` string away. The dedicated kinds (elevenlabs, gemini,
  mistral, openai) exist for direct billing/privacy control — same data,
  no middleman.
- Chat-by-instruction kinds (`gemini`) inherit the chat model's language
  coverage and output-token price, and a commentary-answering model produces
  commentary — the operator owns the model choice.
- `mimo` is a dedicated ASR model on Xiaomi's first-party Open Platform API
  (api.xiaomimimo.com) — the audio part alone is the request; billing is per
  input-audio hour, reported back as `usage.seconds`.
- `onemin` is 1min.AI's /api door — a different wire family from its
  OpenAI-compatible chat door (onemin-speech.ts owns both speech
  directions, one module): audio uploads to the Asset API first
  (multipart field `asset`, `API-KEY` header — not Bearer), the
  SPEECH_TO_TEXT feature takes the returned storage path as
  `promptObject.audioUrl`, and the answer may need polling
  (GET /api/results/:uuid while PROCESSING; STT rides `"async": true`,
  the documented 524-immune door — FAILURE answers carry the provider's
  error object in resultObject, unknown uuids answer
  `aiRecord: null`, both named loudly). The transcript is the
  `resultObject` entry itself — STT's `temporaryUrl` is empty, unlike
  TTS where it is the audio. Caps: qwen3-asr-flash's 10 MB is the
  tightest published feature ceiling (whisper-1's page says ~25 MB
  effective, the Asset API takes 50 MB uploads), so keep-profile
  requests segment under it. One container split: qwen3's format table
  is the only one without MP4 — Telegram video notes arrive as MP4, so
  qwen3 rides the wav profile (16 kHz mono pcm_s16le, 280 s ≈ 9 MB
  segments) while the other documented models keep native containers
  (their tables list both OGG and MP4).
- `language` passthrough is ISO-639-1 (elevenlabs also accepts 639-3;
  onemin takes the ISO code, qwen3's `fil`/`yue`, or the BCP-47 locale
  that latest_short/latest_long and the phone/telephony/medical models
  REQUIRE — every documented 1min STT page documents the knob, a
  missing one fails loud upstream, never faked here); omitted =
  detect everywhere else.
- **Unverified:** `gemini`, `mimo`, `mistral`, `logfare`, and `onemin` are doc-pinned,
  not live-probed (no local key at implementation time). Logfare is an
  OpenAI-compatible relay — its docs note requests may be logged
  (PII-scrubbed) for eval, so it is not the kind to pick for audio you want
  kept off third-party disks. OpenRouter warns ~60 s upstream processing per
  request — long files prefer whistle/groq.

### Borrowed from openclaw

Borrowed from openclaw (MIT, `src/media-understanding/`): the *shape*, not
the code — a local CLI kind (we pin one engine where they probe candidates)
and OpenAI-compatible `/audio/transcriptions` as the shared cloud adapter.
Their plugin registry and per-provider option surfaces are non-goals here.

### Whistle: the local default

Cactus Compute's speech model: one 16.9 MB `.cact` file, CPU-only, 16 kHz
mono in, ≤30 s per pass, detects its 7 languages, returns empty on silence
and steady noise. Integration is the prebuilt engine binary (same container
as their Needle model — `needle_load` reads whichever `.cact` it gets),
spawned per transcription: no daemon, no `--serve`, no Python — a stateless
subprocess. The binary contains no HTTP client and reads no environment —
audio never leaves the box.

- **Artifacts** (x86_64 linux): engine `needle` (1.5 MB) and
  `whistle.cact` (16.9 MB) from `huggingface.co/Cactus-Compute/needle3` and
  `/whistle`, auto-fetched on first use, digest-pinned: digest mismatch =
  fail loud, never run different weights silently. `engine:`/`weights:`
  config bypasses the fetch entirely (managed installs, other platforms).
- **Speed, measured** (g7, i7-8750H): 11 s note → 1.37 s wall including
  model load, ~8× realtime at 16 kHz mono (48 kHz stereo transcodes slowly —
  hence the explicit prep). `--audio-stream` re-transcribes per chunk (120 s →
  3m24s) and is rejected; fixed segments are the pattern.
- **Unverified:** quality on real speech is unmeasured beyond synthetic
  probes — the `transcribed` log's chars/language fields make nonsense
  visible, and cloud kinds are one config flip away.

### Orchestrator (prep and timestamps)

The size-cap decision generalizes:

- `container:"keep"` engines (all cloud) pass the original bytes under the
  provider multipart cap (25 MiB, OpenAI/groq/mistral); over it, mono opus
  segments.
- `container:"wav"` engines (whistle, mimo) always take the 16 kHz mono wav
  pass; fixed segments keep mimo's wav/mp3 input with its 10 MB base64
  ceiling satisfied (180 s of pcm_s16le ≈ 7.7 MB), so a request's size is
  deterministic whatever the source container or bitrate.
- Chat-family inline-base64 engines cap lower to clear the provider's
  request budget (gemini `inlineData` ≈ 20 MB total).
- The segment pass rebuilds timestamps before the muxer sees them (ruling
  2026-10-17, bugs-2026-10 F6): MediaRecorder containers (duration=N/A,
  per-packet cluster pts — PWA voice notes on every browser) cut by real
  wall time once pts are derived from the decoded sample count. Container
  pts are never trusted; contiguous decoded frames are the truth.
- The stored artifact gets the same rebuild at upload: Chromium stamps
  packets on the recording device's monotonic clock — a 14 s note at pts ≈
  uptime played as ~10 h with dead seeking. The gate is content-probed,
  never the declared part type (Bun's formData re-types by extension — webm
  notes arrive claiming `video/webm`); recorder containers re-stamp to an
  honest `audio/*` ref, and an unparseable or unfixable upload stores
  verbatim — a broken note still transcribes and plays, and upload never
  fails over normalization.

## TTS (text → speech)

Server side, `tts.ts` is hand-rolled like ASR: sentence chunks (10k chars),
one synth + ffmpeg ogg remux per chunk — each chunk is a complete standalone
ogg file on the wire (`/api/app/tts`, base64).

**Every door strips reply markdown to spoken text before its speaker
(ruling 2026-10-19).** The tg doors did this from the start (`speakable`,
`speechContent`); the app `/api/app/tts` route now strips too — the client
sends raw reply markdown, and the voice was reading "asterisk asterisk"
through bold text. `stripMarkdown` also speaks shapes, not symbols: table
rows become comma lists (separator rows vanish), horizontal rules drop,
common HTML entities decode, and snake_case splits at its underscores. A
reply that strips to nothing (a pure code block) answers 422 "nothing
speakable in this reply", not silence.

**The app player never chains the ogg parts into one blob (ruling
2026-10-19).** Chained ogg has no usable timeline in any engine — Chromium
stops dead at the first segment's end and Firefox reports
`duration=Infinity` with a seek that never completes (both verified
headless). Each part keeps its own `Audio` element; metadata for every part
preloads before playback and a cumulative duration map translates global
position ⇄ (element, offset), which is what makes the player's seek bar and
±10s steps cross part boundaries. Speed rides `playbackRate` +
`preservesPitch`. An element `error` with sound behind it advances like
`ended` — engines fire `error` instead of `ended` on mildly malformed
stream tails, and audio the operator already heard is not a failed read
(the old per-chunk sequencer printed "playback failed" over a working
playback, 2026-10-19); an error before any sound names its MediaError code.

## Non-goals

- **Chains stay shallow.** Search/fetch chains exist because lookups
  are cheap and failure-prone; a transcript is one deliberate artifact,
  so the retry is the operator's explicit `fallbacks` list — ordered,
  depth-one, capped at four — never a model-improvised engine hop
  (2026-10-19: a groq quota failure once produced a bash-needle
  "fallback"; whistle belongs last in a written chain, not in a tool
  call).
- **No whisper.cpp/sherpa/parakeet probing.** Whistle is the local engine.
  Candidate detection is openclaw's answer to shipping to unknown machines;
  goblin has two.
- **No streaming/realtime ASR.** Telegram voice notes are files; the
  engine's `--audio-stream` is slower than segmentation and its incremental
  shape buys nothing at intake.
- **No provider-option passthrough** (diarize, tag_audio_events,
  transcript_edit, timestamps). The transcript is for the model to read;
  none of that changes the intake artifact. `keywords` on whistle is the one
  bias knob because name errors are the personal-assistant failure mode.

## Verbatim contracts

External request/response and error bodies are pinned verbatim in the engine
test fixtures; probed live 2026-10-09 (openrouter's `ogg` input format
2026-10-10), and the doc-pinned arms (gemini, mimo, mistral, logfare,
onemin) stay **Unverified** until an operator provisions their keys.
One 1min generalization is labeled as such in the fixtures: qwen3-asr-flash's
page carries the only STT response example, so "the transcript is
`resultObject[0]`" is pinned from it and assumed for the family —
whisper-1's page documents no response example.

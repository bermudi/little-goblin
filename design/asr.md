# Speech recognition — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## ASR (speech → text)

Revamped 2026-10: Whistle (Cactus Compute) is the default engine — local,
keyless, one 16.9 MB model file on the CPU — and the cloud is a menu of
explicit kinds behind one interface. Groq stays a kind; the AI SDK
transcription dependency is gone (Engine interface).

Intake semantics do not change. Voice notes and video notes transcribe
once, eagerly; the transcript rides the data-attachment part; attached
audio stays data and uses the `transcribe` tool (DESIGN.md → Model
layer → Transcription, design/tools.md). This doc owns the engine layer.

**A failed intake transcription is recorded, not silently dropped
(ruling 2026-10-17).** The intake catch still keeps the attachment —
transcription is enrichment, not intake — but the part now carries
`transcriptionError` with the bounded provider message, and the
no-audio-modality fallback text renders it (`[attachment: path —
transcription failed: …]`). A silent path-only fallback asked the
model to rediscover failure with tools; the recorded reason turns it
into "your ASR config is broken". Both intake doors populate it (tg
voice/video, app speech); a failure never mints a `transcript` field.

### Engine interface

One interface, nine kinds. Every engine is a function from a prepared
file to `{text, language?}`; the orchestrator (segmentation, silence
semantics, logging) is shared and never sees a provider SDK:

```ts
interface SpeechEngine {
  id: string; // "whistle", "groq/whisper-large-v3-turbo", … — the log line's provider field
  // What the orchestrator must guarantee before calling:
  limits: { maxBytes?: number; maxSeconds?: number };
  // How the orchestrator must prepare audio:
  prep: { container: "keep" | "wav"; sampleRateHz?: number; mono?: boolean };
  transcribe(file: SpeechFile): Promise<{ text: string; language?: string }>;
}
```

- Empty transcript ("no speech") is the ORCHESTRATOR's null, not the
  engine's — engines return whatever the provider said, `""` included.
  Failures throw, always with the provider's name and status in the
  message. A provider outage must never read as silence (#101 rule,
  unchanged).
- `speechEngine(cfg, auth)` (in `transcribe.ts`) maps config → engine;
  auth refs resolve lazily at the point of use, like every other
  provider. Resolved keys never enter logs.
- The AI SDK `transcribe()` call and the `TranscriptionModel` type are
  gone from this layer; `@ai-sdk/groq` is dropped from the deps (chat
  never used it — it existed only for transcription). Precedent: TTS
  is hand-rolled Edge over WebSocket (`tts.ts`); ASR now matches.

### Config

```jsonc
// absent or "" → transcription off (unchanged)
transcription: {
  kind: "whistle",            // default recommendation; see kinds below
  // whistle-only:
  engine: "/path/to/needle",  // optional — skip auto-fetch, use this binary
  weights: "/path/to/whistle.cact", // optional — and this model file
  keywords: ["goblin", "bermudi"],  // optional — keyword bias (≤100)
  // cloud kinds carry model + auth; auth defaults to the kind name:
  // model: "whisper-large-v3-turbo", auth: "groq"
}
```

Kinds (`zod` discriminated union in `config.ts`):

| kind | default model | auth default | mechanism | languages |
| --- | --- | --- | --- | --- |
| `whistle` | — (whistle.cact) | none | local engine binary | en de fr es it nl pl, detected |
| `groq` | `whisper-large-v3-turbo` | `groq` | multipart `POST api.groq.com/openai/v1/audio/transcriptions` | 99, detected |
| `openai` | `gpt-4o-mini-transcribe` | `openai` | multipart `POST api.openai.com/v1/audio/transcriptions` | 99, detected |
| `openrouter` | `openai/whisper-large-v3` | `openrouter` | JSON `POST openrouter.ai/api/v1/audio/transcriptions` | per model |
| `mistral` | `mistralai/voxtral-mini-3b-2507` | `mistral` | multipart `POST api.mistral.ai/v1/audio/transcriptions` | multilingual, detected |
| `elevenlabs` | `scribe_v2` | `elevenlabs` | multipart `POST api.elevenlabs.io/v1/speech-to-text` | 90+, detected |
| `gemini` | `gemini-flash-latest` | `gemini` | REST `generateContent` with inline audio + verbatim-transcription prompt | per model |
| `mimo` | `mimo-v2.5-asr` | `mimo` | first-party `POST api.xiaomimimo.com/v1/chat/completions` — dedicated ASR model, `input_audio` wav/mp3, no prompt | auto zh en |
| `logfare` | `whisper-large-v3-turbo` | `logfare` | multipart `POST logfare.ai/v1/audio/transcriptions` | 99, detected |

- `auth` optional on cloud kinds, defaulting to the kind name — the
  auth.jsonl record the operator is expected to add (`groq` precedent).
  `mimo` rides Xiaomi's first-party Open Platform API
  (api.xiaomimimo.com); billing is per input-audio hour, reported back
  as `usage.seconds`.
- `openrouter` is the metaprovider: its STT catalog (verified 2026-10-09:
  elevenlabs scribe-v2, gemini-3.5-transcribe, chirp-3, voxtral, qwen3-asr,
  whisper, gpt-transcribe, mai-transcribe, grok-stt, nova-3 …) is one
  `model:` string away. The dedicated kinds (elevenlabs, gemini, mistral,
  openai) exist for direct billing/privacy control — same data, no
  middleman.
- Chat-by-instruction kinds (`gemini`) transcribe by instruction: system
  prompt demands verbatim transcript only, temperature 0, output capped.
  They inherit the chat model's language coverage and its price per
  output token; they do NOT get special parsing — `choices[0].message
  .content` / `candidates[0].content.parts[].text`, trimmed, treated as
  the transcript. A model that answers with commentary produces
  commentary; the config names the model, the model is the operator's
  choice. `mimo` shares the chat-completions envelope but is a
  *dedicated* ASR model: the audio part alone is the whole request, and
  its `asr_options.language` vocabulary is closed (auto/zh/en), so its
  `language` field is that enum, not the ISO free string.
- Optional `language` passthrough on every kind (ISO-639-1; whistle's
  enum, elevenlabs also accepts 639-3, mimo its own closed enum).
  Omitted = detect everywhere.
- **Unverified:** `gemini`, `mimo`, `mistral`, and `logfare` are
  doc-pinned, not live-probed (no local key at implementation time).
  Logfare is an OpenAI-compatible relay — its docs note requests may be
  logged (PII-scrubbed) for eval, so it is not the kind to pick for
  audio you want kept off third-party disks. OpenRouter warns ~60 s
  upstream processing per request — long files prefer whistle/groq.

### The two adapter families

**OpenAI-compatible multipart** (groq, openai, mistral, logfare): one fetch
implementation, four base URLs. Fields `file`, `model`, `language?`;
`Authorization: Bearer <key>`; response `{"text": …}` (groq's
verbose_json adds `language: "English"` — full words, not codes — and
`duration`; pass `response_format: json` for the minimal shape).
Mistral's errors are FastAPI-shaped `{"detail": …}` — error rendering
reads `error.message ?? detail ?? body`.

**Bespoke** (whistle engine binary, elevenlabs multipart with
`xi-api-key` + `model_id`, gemini generateContent, openrouter JSON with
base64 `input_audio`, mimo first-party chat completions). Each is small,
each pinned verbatim in tests with the shapes recorded in the appendix.

Borrowed from openclaw (MIT, `src/media-understanding/`): the *shape*,
not the code — local CLI transcription as a first-class provider kind
(their `local-audio.ts` probes parakeet/whisper.cpp/sherpa candidates;
we pin exactly one engine instead of probing), and OpenAI-compatible
`/audio/transcriptions` as the shared cloud adapter (their
`openai-compatible-audio.ts`). Their multi-provider plugin registry and
per-provider option surfaces are non-goals here.

### Whistle: the local default

Cactus Compute's speech model: one 16.9 MB `.cact` file, CPU-only, 16 kHz
mono in, ≤30 s per pass, detects its 7 languages, returns empty on
silence and steady noise. Integration is the prebuilt engine binary
(same container as their Needle model — `needle_load` reads whichever
`.cact` it gets), spawned per transcription. No daemon, no `--serve`,
no Python: stateless subprocess like every other goblin child.

- **Artifacts** (x86_64 linux): engine `linux-x86_64/needle` (1.5 MB)
  and `whistle.cact` (16.9 MB) from `huggingface.co/Cactus-Compute/
  needle3` and `/whistle`, auto-fetched on first use into
  `$GOBLIN_HOME/cache/whistle/`, digest-pinned:
  needle `f38dc4b0345d66b4e385734ad0f12af43ac6e2cfa1752d0795af5c137200c8e4`,
  whistle.cact `b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb`.
  Digest mismatch = fail loud, never run different weights silently;
  the error names the override fields. `engine:`/`weights:` config
  bypasses the fetch entirely (managed installs, other platforms —
  the fetcher maps `process.arch`; unmapped = loud error with the
  manual-path instruction).
- **Invocation**: `needle --model <weights> --audio <wav>` (+ optional
  `--audio-language <code>`, `--audio-keywords <file>`, `--threads N`).
  stdout: one JSON line `{"text","language","ttft_ms","decode_tps"}`;
  exit 1 with a one-line stderr message on bad input. Silence →
  `{"text":"","language":""}`. The binary contains no HTTP client and
  reads no environment — audio never leaves the box.
- **Prep**: RIFF WAV only — every call is one ffmpeg pass to 16 kHz
  mono `pcm_s16le` (`prep: {container:"wav", sampleRateHz:16000,
  mono:true}`), `-f segment -segment_time 28` (the 30 s engine limit
  with cut-margin) so one pass handles short notes and hour-long
  podcasts alike. Segments transcribe sequentially, joined with
  spaces; per-segment results log; a failed segment keeps the prefix
  (orchestrator rule, unchanged). Guard: >240 segments (≈1 h 52 m)
  errors loud instead of grinding the CPU for an afternoon.
- **Speed, measured** (g7, i7-8750H, this branch): 11 s note → correct
  transcript in 1.37 s wall including model load; ~8× realtime at
  16 kHz mono (48 kHz stereo input works natively but transcodes
  slowly — hence the explicit 16 kHz prep). 120 s clip through
  `--audio-stream` took 3m24s (re-transcribes per chunk) — streaming
  mode is rejected; fixed segments are the pattern, same as the
  over-cap cloud path today.
- ffmpeg becomes a hard dependency of the whistle kind (it is the
  decoder); the boot probe warns when missing exactly like today, and
  intake degrades per message to the path-referenced attachment.
- **Unverified:** quality on real speech is unmeasured beyond synthetic
  probes — the `transcribed` log's chars/language fields make nonsense
  visible, and cloud kinds are one config flip away.

### Orchestrator (unchanged shape, new prep awareness)

`transcribeAudio(engine, file, opts)` keeps its contract: null = no
speech anywhere, throw = failure. The size-cap decision generalizes:

- `container:"keep"` engines (all cloud): today's behavior — under
  `maxBytes` (default 25 MiB, OpenAI/groq/mistral multipart cap) pass
  the original bytes; over it, 15-minute 48 kHz mono opus segments.
- `container:"wav"` engines (whistle, mimo): always the 16 kHz mono wav
  segment pass above; `maxSeconds` per segment — 28 for whistle's 30 s
  engine cap, 180 for mimo (its contract is wav/mp3 and a 10 MB base64
  ceiling; 180 s of pcm_s16le encodes to ≈7.7 MB, so the profile makes
  request size deterministic whatever the source container or bitrate).
- Chat-family inline-base64 engines cap bytes lower (gemini
  `inlineData` request budget ≈ 20 MB total): `maxBytes` 12 MiB with
  10-minute segments keeps the base64-inflated body safely under.

### Wire, UI, docs

- `ConfigPostBody.transcription` (src/http/mod.ts) widens to the union;
  the settings editor's Voice card gains a kind `<select>` (whistle
  first), a model input with per-kind placeholder default, and an auth
  input disabled for whistle. The editor (`app/src/settingsDraft.ts`,
  served on both doors) mirrors the same rules: a kind switch clears
  model and secret, and a blank cloud model or secret is valid because
  the server fills the kind's defaults — schema changes break
  typecheck, not the page (App channel rule).
- Boot log: one line naming engine, model, and (whistle) artifact
  presence. Every transcription logs provider, model, duration, chars,
  language — the existing `transcribed` line, generalized.

## Non-goals

- **No fallback chains** for transcription. Search/fetch chains exist
  because lookups are cheap and failure-prone; a transcript is one
  deliberate artifact. One kind, explicit. (The interface makes a
  chain a config feature later if it's ever wanted.)
- **No whisper.cpp/sherpa/parakeet probing.** Whistle is the local
  engine. Candidate detection is openclaw's answer to shipping to
  unknown machines; goblin has two.
- **No streaming/realtime ASR.** Telegram voice notes are files; the
  engine's `--audio-stream` is slower than segmentation on our CPUs
  and its incremental shape buys nothing at intake.
- **No provider-option passthrough** (diarize, tag_audio_events,
  transcript_edit, timestamps). The transcript is for the model to
  read; none of that changes the intake artifact. `keywords` on
  whistle is the one bias knob because name errors are the personal-
  assistant failure mode.

## Verbatim contracts (pinned for tests)

Probed live 2026-10-09; the test fixtures copy these bodies exactly.

```
# groq (auth Bearer) POST api.groq.com/openai/v1/audio/transcriptions
# multipart: file, model, response_format=verbose_json → 200:
{"task":"transcribe","language":"English","duration":5.603,
 "text":" Hey Goblin, please turn off the kitchen lights and set a timer for 10 minutes.",
 "segments":[…],"x_groq":{"id":"req_…"}}
# 401 → {"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}

# openrouter POST api/v1/audio/transcriptions, JSON body
# {model, input_audio:{data:<b64>, format:"wav"}} → 200:
{"text":" Hey Goblin, please turn off the kitchen lights and set a timer for 10 minutes.",
 "usage":{"seconds":5.603,"cost":0.0000420225}}
# format:"ogg" verified live too (2026-10-10, implementation day):
{"text":" *phone rings*","usage":{"seconds":3,"cost":0.0000225}}

# mistral POST v1/audio/transcriptions (multipart) 401 → {"detail":"Invalid API Key"}
# openai POST v1/audio/transcriptions (multipart) 401 → {"error":{"message":"Incorrect API key provided: …","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}

# elevenlabs POST v1/speech-to-text, header xi-api-key, multipart
# {model_id:"scribe_v2", file} → 200 {"language_code":"en","language_probability":1,"text":…,"words":[…]}

# whistle engine: stdout = one JSON line {"text","language","ttft_ms","decode_tps"};
# errors: exit 1, stderr one-liner ("audio limit is 30 s", "cannot read X (RIFF WAV)", "cannot load …: unreadable")

# logfare (doc-pinned, unverified live — no key at implementation time)
# POST logfare.ai/v1/audio/transcriptions, Bearer, multipart {file, model,
# language?} → {"text": …}; catalog: whisper-large-v3-turbo, nova-3
```

Gemini (`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`,
header `x-goog-api-key`, `contents[].parts[].inlineData {mimeType, data}`)
rides the docs' shape; its fixtures stay doc-pinned until the first live
call at operator setup (no local key). The mimo arm
(`api.xiaomimimo.com/v1/chat/completions`, header `api-key`,
`{model:"mimo-v2.5-asr", messages:[{role:"user", content:[{type:
"input_audio", input_audio:{data,format:"wav"}}]}], asr_options?}` →
`choices[0].message.content`, `usage.seconds` = billed audio duration)
is doc-pinned the same way until a `mimo` auth record exists — the
OpenRouter chat probe that justified this kind's original shape is
retired along with that wire.


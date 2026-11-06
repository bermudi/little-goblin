> Audited 2026-10-23 16:41 local, at repo commit `59d3f7d7` (tracked tree clean; only untracked audit/ notes). Production files are identical at `9d4f861e`, the HEAD this audit closed on — its sole change is app/src/WindowView.test.tsx.

# Hunt 05 — voice: ASR/TTS engines, orchestrator, recording, app player

Repo: goblin v2 (`/home/daniel/build/little-goblin`), read-and-report only.
Governing spec: `design/asr.md` (+ `DESIGN.md` → Non-goals item 2, AGENTS.md →
Guardrails). Scope: `src/agent/{onemin,onemin-speech,recording,transcribe,
transcribe-cloud,transcribe-whistle,tts,tts-cloud}.ts`, `app/src/speech.tsx`,
plus colocated tests.

Baseline: scoped suite `133 pass / 0 fail` (brief's exact command, run from
repo root); `bun run typecheck` green (both tsc programs). Verification
probes run from `/tmp/hunt05-probe.test.ts` (no repo edits, no network, no
live services).

## 1. Findings (most severe first)

No P0, P1, or P2 findings. The area's contracts are heavily pinned by its
tests; everything concrete I could prove is invariant-hygiene grade (P3).
Four findings below, then out-of-scope pointers.

### F1 (P3, invariant hygiene) — `stripMarkdown` is not idempotent for entity-decoded tag text, and the invariant's stated premise does not exist in the wiring

- **Where:** `src/agent/tts.ts:378-429`. The tag strip (`.replace(/<[^>]+>/g, "")`,
  line 403) runs **before** the entity decode (lines 404-420). The code's own
  invariant, tts.ts:379-381: "The result must be idempotent — tg callers
  pre-strip, then the speaker boundary strips again."
- **Evidence (probe A1, ran):** `speakable("use &lt;div&gt; and &lt;think&gt;tags&lt;/think&gt; here")`
  → `"use <div> and <think>tags</think> here"` (entities decode after the tag
  strip, so the decoded tags survive); applying the strip **again** → `"use  and tags here"`
  — words silently deleted by the second pass. The one-strip output is faithful
  (a single strip is correct behavior); the second strip destroys content.
- **Triggering path today: none found.** I traced every speaker boundary:
  `src/tg/delivery.ts:864` strips once (then `voice.synthesize`), 
  `src/tg/speak-button.ts:73` strips once, `src/http/app-chat.ts:125` strips
  once (then `deps.speak`), `src/agent/tools/speak.ts` does **not** strip, and
  `synthesizeSpeech` never strips. So the comment's "the speaker boundary
  strips again" is false in the current tree — the invariant is latent, not
  live. Either the comment is stale (delete/fix it), or a second strip was
  lost somewhere and the non-idempotency becomes silent content loss the day
  it returns. No asr.md ruling is violated by current behavior (asr.md → TTS
  describes single-strip semantics: "Every door strips reply markdown to
  spoken text before its speaker (ruling 2026-10-19)").
- **Test sketch:** `expect(speakable(speakable("use &lt;div&gt; and &lt;b&gt;x&lt;/b&gt; here"))).toBe(speakable("use &lt;div&gt; and &lt;b&gt;x&lt;/b&gt; here"))` — the
  existing idempotency test (tts.test.ts:107-108) only covers the table case.

### F2 (P3, lead) — onemin STT keeps only `resultObject[0]`; extra entries are silently dropped

- **Where:** `src/agent/onemin-speech.ts:398-404` — `const text = results[0] ?? "";`
- **Rule:** asr.md → Verbatim contracts: "One 1min generalization is labeled
  as such in the fixtures: qwen3-asr-flash's page carries the only STT
  response example, so 'the transcript is `resultObject[0]`' is pinned from
  it and **assumed for the family** — whisper-1's page documents no response
  example." The doc pins single-entry as the working assumption; the code
  takes `[0]` and ignores any further entries without a log line.
- **Evidence (probe C1, ran):** a SUCCESS envelope with
  `resultObject: ["first half", "second half"]` returns `{text: "first half"}`
  — "second half" vanishes with no warn. This matters specifically because
  keep-profile onemin segments are up to **15 minutes** of audio per request
  (onemin-speech.ts:368, asr.md → Config) — the one case where a provider
  plausibly answers multiple entries.
- **Why only a lead:** the wire is doc-pinned, not live-probed (asr.md marks
  onemin **Unverified**); no written contract says multi-entry occurs. But the
  module's own posture for unexpected shapes is "names itself" (missing or
  object-shaped resultObject throws loudly, onemin-speech.ts:398-403) — a
  `results.length > 1` warn (or joining the entries) would match that posture
  and cost nothing. Sketch: fixture with a two-entry array, assert either a
  loud log or a joined transcript.

### F3 (P3, lead) — whistle cache artifacts are trusted without digest re-verification

- **Where:** `src/agent/transcribe-whistle.ts:130` — `if (existsSync(dest)) return dest;`
- **Rule suspected:** asr.md → Whistle: "auto-fetched on first use,
  digest-pinned: digest mismatch = fail loud, never run different weights
  silently." The pin guards the **download** (line 146-151); a cached file is
  executed/read as-is forever after. A corrupted or replaced
  `cache/whistle/needle` / `whistle.cact` runs different weights silently —
  the exact outcome the ruling says must never happen. I could **not** trace a
  written requirement to re-verify on every use (the durable write is atomic,
  so partial files are not the concern); this is a spirit-of-the-ruling lead,
  not a cited violation.
- **Test sketch:** fetch once into a cacheDir, overwrite `whistle.cact` with
  garbage, transcribe again — currently returns whatever the stub says with no
  complaint.

### F4 (P3) — onemin poll loop double-wraps the named "no such result record" error

- **Where:** `src/agent/onemin-speech.ts:179-190`. The `aiRecord: null` case
  throws the carefully-named "no such result record (uuid X) — deleted,
  expired, or another key's record" (lines 183-185, per Get Result API → Not
  Found), but it is thrown **inside** the poll `try`, whose catch re-wraps
  every failure.
- **Evidence (probe B1, ran):** message becomes
  `onemin: result poll failed (uuid u1) — onemin: no such result record (uuid u1) — deleted, expired, or another key's record`.
  The module header says both cases are "named loudly"; the name survives but
  is buried one wrap deep. Cosmetic only — the reason text is intact. The
  existing test (onemin-speech.test.ts:496-520) matches via unanchored regex,
  so it cannot catch the double wrap.
- **Fix sketch (not applied):** move the `polled === null` check outside the
  try, or rethrow that specific error unwrapped.

### Out-of-scope pointers (noted, not chased)

- **`src/http/app-chat.ts:229-251`** — app speech attachments whose
  transcription returns null ("no speech") keep `transcript === undefined`
  forever, so **every send of that message re-transcribes** (billed on cloud
  kinds). tg intake has no such loop (transcribes once at intake,
  `src/tg/mod.ts:555-572`). Owner should confirm intended.
- **`src/config.ts:709-711` + `740`** — elevenlabs rides the shared
  `transcriptionLanguage` regex (strict `^[a-z]{2}$`), so asr.md → Config's
  "elevenlabs also accepts 639-3" is unreachable through config: an operator
  setting `language: "spa"` is rejected at the boundary. Doc mentions a
  capability the schema forbids.
- **`app/src/ChatView.tsx:1528-1541`** — the brief's "recording capture path"
  probe point lives here, **not** in the scoped `speech.tsx` (which is the
  read-aloud player). Unverified lead from a skim: `startRecording`'s
  `recording` state guard is checked before an `await getUserMedia`, and
  `setRecording(true)` lands only after it — a second pointerdown during the
  await (e.g. two-finger touch) passes the guard and creates a second
  MediaRecorder; the first is never stopped (mic stays hot, its chunks never
  sent). Tail-drop and release-send logic otherwise look correct
  (`start(250)` timeslice, final `ondataavailable` before `onstop`,
  `recCancel` flag, busy-gated staging).
- Telegram media intake plumbing (`src/tg/media.ts`, `mod.ts`) and the
  speak/transcribe agent tools are hunts 1/10 per the brief.

## 2. Simplifications & code smells (scoped files, P3, evidence-backed)

- **Duplicated timeout formula** — `src/agent/tts.ts:23-29`
  (`EDGE_TIMEOUT_BASE_MS/PER_CHAR_MS/MAX_MS` + `edgeTimeoutMs`) is
  byte-identical to `src/agent/tts-cloud.ts:24-35` (`TIMEOUT_*` + exported
  `timeoutMs`): same 30 s base, 40 ms/char, 300 s cap. tts-cloud's comment
  even documents cross-module reuse (onemin-speech imports it as
  `voiceLaneTimeout`); the edge copy should call it too, or the constant trio
  lives once in tts.ts and tts-cloud imports it.
- **`budget` name shadowing** — `src/agent/onemin-speech.ts:216-219`:
  `uploadAsset`'s parameter `budget: { signal: AbortSignal }` shadows the
  module's `budget()` factory (line 114); reading `budget.signal` inside
  looks like the factory's product (which it is), but any future edit adding
  a second `budget(...)` call inside that function would resolve to the
  parameter. Rename the param (e.g. `b`, matching `callFeature`).
- **Dead export** — `src/agent/onemin.ts:28-29`: `ONEMIN_DOCS_URL` is
  exported and referenced nowhere else in `src/` or any test (rg, non-test
  and test). Either cite it in the relay-truth comments/errors where it
  belongs or drop it.
- **Segments are sent to providers with an absolute temp path as filename** —
  `src/agent/transcribe.ts:190-195`: `filename: seg` is
  `/tmp/goblin-tr-XXXX/seg_0001.wav`; multipart engines append it verbatim as
  the File's name (groq/openai/mistral/logfare/elevenlabs via
  transcribe-cloud.ts:156-157, onemin's Asset upload via
  onemin-speech.ts:224-226). No secret leaks, but it breaks the
  `SpeechFile.filename` contract used everywhere else (client filename) and
  ships fs layout to third parties. `seg.split("/").pop()` would do.
- **Inconsistent truthiness predicates in `checkBootMedia`** —
  `src/agent/transcribe.ts:366` and `374` test `config.tts` (truthiness) while
  line 383 spells `config.tts !== false && config.tts !== undefined &&
  config.tts.kind !== "edge"` — the same gate in two forms. The long form
  collapses to `config.tts && config.tts.kind !== "edge"`.
- **Data-as-code word lists** — `src/agent/tts.ts:38-283`: ~245 of the
  module's 760 lines are inline `Set` literals (ES_WORDS/EN_WORDS). Pure
  data with one consumer (`detectLanguage`); a sibling `tts-cast.ts` (or a
  frozen data module) would leave tts.ts about speech. Borderline — flagging
  because of the ratio, not taste.

## 3. Checked and found clean (later passes can skip)

- **Chain semantics vs asr.md → Config:** ordered retry after the block's own
  kind, engine-failure-only advance, no-speech `null` ends the run (never a
  retry trigger), depth-one by config construction (`fallbacks` has no nested
  fallbacks), `.max(4)` enforced at the config boundary (config.ts:791),
  fully-failed chain throws one error naming each engine with per-link
  slicing (transcribe.ts:309-336). Tests pin all of it.
- **Silence-vs-failure (#101, asr.md → Engine interface):** every engine
  throws with provider name + status in the message and maps provider-empty
  to `""` → orchestrator `null`: whistle (exit≠0, non-JSON, shape), multipart
  (renderError flavors groq/openai/mistral/elevenlabs/gemini), gemini refusal
  (`finishReason` ≠ STOP with empty transcript throws; MAX_TOKENS warns),
  mimo (no-choices throws; empty content is silence), onemin (FAILURE error
  object surfaced with code+message; unknown-uuid null named; SUCCESS without
  array-shaped resultObject is drift and throws; empty array is the null).
- **Intake failure recording (ruling 2026-10-17):** tg door
  (src/tg/mod.ts:555-572) and app door (src/http/app-chat.ts:229-251) both
  catch, keep the attachment, record a bounded `transcriptionError`, and never
  mint `transcript` on failure. (Pointers only — those files belong to hunts
  1/3.)
- **Temp-file hygiene:** `transcribeSegmented` (mkdtemp + finally rm),
  `preparedInputAudio` (finally cleanup, and the caller runs it in `finally`),
  whistle keywords dir (assigned before the risky writes, finally rmSync),
  recording `${path}.norm` (finally unlink, ENOENT swallowed deliberately).
  No leak on any error path I could construct on paper; existing tests cover
  the failure paths that matter.
- **Caps/limits vs asr.md → Orchestrator:** whistle 28 s segments / 16 kHz
  mono pcm_s16le; keep-profile 25 MiB → mono-48k-opus 15-min segments;
  gemini 12 MB / 10-min; mimo 180 s wav; onemin keep 10 MB / 15-min and
  qwen3 wav 280 s ≈ 9 MB under the 10 MB feature ceiling; MAX_SEGMENTS 240
  fails loud. All arithmetic checks out against the doc.
- **zod at boundaries / no `any`:** every provider response parsed through
  zod (multipart, elevenlabs, openrouter, gemini, chat, mimo chat, onemin
  envelope + asset, whistle engine output, recording ffprobe); error bodies
  via `renderError` with capped heads; typecheck green across both programs.
- **Key hygiene (asr.md → Engine interface):** keys resolve lazily at point
  of use, ride headers only, never URLs; onemin's audio download of the
  signed `temporaryUrl` carries no API-KEY header (fixture asserts); no key
  material in any log line I reviewed.
- **Edge TTS socket (tts.ts:483-594):** one budget covering the whole
  synthesis (30 s + 40 ms/char, 300 s cap), terminate on fail/timeout, binary
  frame header bounds checked, `turn.end` with zero audio **fails loud**
  ("returned no audio" — empty audio is never silence), close-before-complete
  names code+path, handshake rejected → HTTP status.
- **App player (speech.tsx) vs asr.md → TTS rulings:** per-part `Audio`
  elements, metadata preloaded for all parts before playback, global-position
  ⇄ (element, offset) map, `playbackRate`+`preservesPitch`, error-after-sound
  advances while error-before-sound names the MediaError code, autoplay-block
  leaves the player open for a gesture retry. Blob-URL lifecycle is clean on
  every abort path I traced (gen-guarded start, stop, unmount cleanup,
  cross-instance `liveStop`), no double-submit (loading disables + gen guard).
  Tests cover sequencing, boundary seeks, rate persistence, both error kinds.
- **MediaRecorder pts rebuild (ruling 2026-10-17 F6):** `asetpts=N/SR/TB` at
  both the segmenter (transcribe.ts:259-260) and upload normalization
  (recording.ts:129-131); gate is content-probed (ffprobe), audio-only,
  duration-missing, recorder-container; upload never fails over
  normalization — the app caller catches probe/remux failure and stores
  verbatim (src/http/app-attachments.ts:58-63). Tests pin all branches
  including the video-untouched case.
- **onemin chat-door truths (onemin.ts):** host match is exact-host
  (look-alike subdomains fail), retry budget 0 only on the relay, others keep
  SDK default; pinned by tests.
- **TTS chunking:** sentence-boundary chunks, per-kind limit (onemin 4k under
  the 4,096 doc cap), surrogate-pair-safe oversized split (limit-1/limit-2
  regression tests), mp3/webm remux selection matches each kind's container,
  remux validates the `OggS` magic, mid-synthesis failure propagates (tg
  voice mode falls back to text delivery; app door answers 500, missing-tts
  answers 503, empty-strip answers 422 "nothing speakable").

## 4. Couldn't verify / suspected but untraceable

- **Live wire contracts for the doc-pinned engines** (gemini, mimo, mistral,
  logfare, onemin — asr.md → Verbatim contracts marks them **Unverified**
  until an operator provisions keys). Everything I checked is
  fixture-vs-code; real drift (endpoints, envelopes, the resultObject[0]
  assumption of F2) is only discoverable live, and the rules of engagement
  forbade live probes. No provider was contacted.
- **F1's premise:** could not find any code path where the speaker strips a
  second time; cannot tell from the tree whether the comment is stale or a
  boundary was lost. If someone knows a door that double-strips, F1 becomes
  a live P2 (silent content deletion).
- **F3:** could not trace a written rule requiring per-use digest
  re-verification of cached whistle artifacts; flagged as spirit-of-ruling.
- **Whistle real-binary behavior** (30 s per-pass ceiling, 7-language set,
  empty-on-noise): pinned from docs + the module's own constants; I did not
  fetch or run the artifact (that would hit the network and mutate the
  cache).
- **Edge TTS live acceptance** of the `Sec-MS-GEC` token by
  `api.msedgeservices.com`: code follows the known client algorithm; no live
  socket was opened.
- **The `ssml` timestamp oddity** (tts.ts:555-556 appends `Z` to a timestamp
  string that already ends with "(Coordinated Universal Time)"): looks wrong
  but matches the widely-cloned edge client shape; can't verify without a
  live socket, and no doc in-repo pins it. Lead only.
- The brief's "app recording capture path" probe point is in
  `ChatView.tsx`, outside the scoped file list; my pointer there
  (double-start race) is a skim, explicitly unverified.

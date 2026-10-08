# Model layer — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Model layer

Vercel AI SDK (`ai` package). `streamText` with tools and `stopWhen` for the
agent loop.

- **Provider registry** in config: name → AI SDK provider factory + auth
  reference. v1 targets:
  - `zai` — GLM via z.ai's OpenAI Responses endpoint (`/api/v1`, the
    `responses` kind over `@ai-sdk/openai`) — the coding-plan door that
    carries documents in tool results (see Web access). Daily driver.
    The `openai-compatible` kind (chat completions) stays available for
    any OpenAI-shaped relay.
  - `openrouter` — `@openrouter/ai-sdk-provider`.
  - `codex` — `ai-sdk-provider-codex-cli` exists (ChatGPT Plus/Pro auth via
    `codex` CLI login) but wraps the CLI's own agent loop — no caller tools,
    so it can't drive goblin's turn loop. Ours is a thin `LanguageModelV4`
    over `chatgpt.com/backend-api/codex/responses` (`src/agent/codex/`):
    reads `~/.codex/auth.json` per call (auth.ts), refreshes expired
    access tokens against the OAuth endpoint, and writes rotated refresh
    tokens back — not writing back would invalidate the CLI's own login.
- **Selection scope (2026-10-06)**: Telegram uses one shared
  `telegram.model`/`telegram.thinking` selection across all DMs/topics;
  retired per-Telegram-conversation columns never override it. Root
  `model`/`thinking` are app defaults, snapshotted durably into each new
  app conversation. Legacy config without Telegram keys normalizes them
  from root values before patches, and saves persist the explicit pin so
  app-default changes cannot leak into Telegram. Existing app rows
  initialize once (see design/app.md). Settings are captured at turn
  admission, including attachment/vision capability gates, and remain
  fixed through overflow retry and automatic compaction; edits apply to
  the next turn without fencing this one. Manual `/compact` resolves the
  channel selection when it executes. Summaries use that same model and
  thinking; reviewer fallback uses the conversation's model, while
  explicit `reviewer.model` and `titleModel` remain independent.
- **Thinking**: `off|low|medium|high|xhigh|max` is an operator vocabulary,
  not a provider contract — `thinkingOptions` maps each family to the
  nearest honest knob and writes the collapse down; `thinkingLevelsFor`
  is the same table read the other way, and the mini app offers only what the active model can express. Family ladders follow the bare
  model id under every kind — a `glm-5.3` is forced-thinking whether z.ai
  serves it directly or via a relay. Stored values outside a model's set
  aren't errors — defaults span models, so the mapping clamps them to the
  nearest rung at-or-above (GLM's own collapse direction). GLM
  (docs.z.ai): 5.3+ is forced thinking with effort `low|high|max`
  (unlisted values silently become `max`; `off`/`medium` clamp to `low`/
  `high`), 5.2 toggles plus `high|max`, ≤4.6 toggles only. Endpoint
  caveat: z.ai's coding plan (`api.z.ai/api/coding/…`) serves only
  5.3-gen models and aliases older glm-* ids to them, so on that base
  URL every glm gets the 5.3 ladder and wire map. GPT/codex
  takes `reasoning_effort` verbatim on a `low|medium|high|xhigh` ladder
  (gpt-6 adds `max`); `off` isn't a rung and clamps to the floor.
  OpenRouter's public `/models` catalog is fetched + cached like
  models.dev: `supported_parameters` discriminates `reasoning_effort`
  (native ladder → verbatim), `reasoning` only (toggle → `off|low`), or
  neither (non-reasoner → `off`); a cold catalog passes the level
  through — fail loud, never fake knowledge. `off` = `enabled:false`. No
  `/think` command — the mini app owns the knob.
- **History**: stored as AI SDK `UIMessage`-format JSON (the parts array —
  text, reasoning, tool, file parts), wrapped in a versioned envelope
  `{"v":1,"message":…}`: the SDK owns the part shapes, so every row stamps
  the format that wrote it — a future shape change is a deliberate
  `v1→v2` converter at open, never silent placeholder degradation of old
  rows. `openStore` migrates bare (pre-envelope) rows once; the read is
  envelope-only (a straggler that somehow skips the wrap degrades to a
  placeholder, never parses as speech).
- **Causal view, arrival-order storage.** `events` appends in arrival seq —
  that stays the truth. What the model sees interleaves replies by
  `anchor_seq`: each assistant response is stamped with the seq of the
  last user message of the burst it answers (steered submits included,
  bounded by the turn's ownership mark) and sorts immediately after it,
  so a reply never reads as having seen input that arrived after it
  finished. Input that queues behind a finished turn — post-stream
  arrivals — coalesces into one successor turn — a single model call
  answers it — and consecutive user messages merge into one at
  conversion.
- **Compaction**: history is unbounded on disk, bounded in the window by
  pointer relocation, never deletion. A conversation whose completed turn
  crosses **75% of its model's catalog context window** — or the operator's
  `/compact` — compacts: the conversation's own model (a summary is a
  compression of everything the agent knew; a sloppy one silently degrades
  every future turn, and it runs rarely) summarizes everything from the
  previous boundary (or the start) up to a cut chosen at a **completed
  exchange** — the causal-view rule, so a response is never orphaned from
  its user message — keeping a recent tail inside a token budget (~25% of
  the window, estimated). An interleaved burst (operator messages that
  arrived mid-turn) is atomic: the cut coarsens to whole bursts rather
  than splitting them. The summarizer input is the delta since the
  previous boundary plus the previous summary — never the re-serialized
  whole past, so the summary call stays bounded by one compaction
  interval, not by total history. Within that bound it is chunked
  further: sequential calls, each carrying the running summary forward,
  sized so system + carried + span text fit half the window (32k when
  the window is unknown); a single oversized event is truncated, never
  allowed to stall the fold. Each call races a 3-minute timeout — a
  wedged request must settle — and a timeout is an ordinary failure. The result lands in a first-class `compactions`
  table (boundary seq, summary, tokens before, model, timestamp); the latest
  row is the conversation's active pointer and earlier rows are the audit
  trail. The event stream is untouched — arrival-order storage stays the
  truth, and the full record remains queryable forever. The model view
  becomes [summary message] + events whose causal position follows the
  boundary — `anchorSeq ?? seq`, the same key the causal sort uses, so a
  late answer to a folded question rides into the summary with it rather
  than stranding orphaned in the tail. The summary is
  minted at read time as a user-role message framing the carried context.
  The requestHash move is the sanctioned boundary (Cache stability), logged
  as `history compacted` with the numbers. Failure is loud and lossless: a
  failed summary call writes no boundary and warns; the next threshold
  crossing retries. `/stop` and shutdown abort an in-flight summary —
  no pointer is written, the crossing retries. An epoch-bumping settings
  change (the authority rule) fences the same commit: the compaction
  captures its epoch at entry and re-checks before each summary chunk and
  before the pointer lands, so a fence mid-summary spends no further
  calls, writes no boundary, clears no frozen prompt snapshot — the next
  crossing retries under the new settings. Auto-compaction runs inside the conversation's serial
  lane after the turn's sinks are notified — the reply lands first, a
  queued successor waits out the summary call. `/compact` is the same
  compaction serialized through the conversation's lane — a running turn
  completes (its response appended) before the cut is chosen, and a
  queued submit waits out the summary call — and replies with the
  numbers; with the context
  window unknown it still compacts (manual is a forced scrub). The ≥80%
  utilization warn stays as the alarm that compaction didn't happen or
  didn't keep up. A provider's **context-overflow error** mid-turn is a
  recovery, not a failure — the mechanism borrowed from pi
  (`~/build/pi-mono` `agent-session._checkCompaction`): the failed
  attempt's partial reply is held off the wire, one compaction runs with
  a halved tail budget (the overflow proved the estimate optimistic for
  this conversation), and the turn resumes on the compacted view,
  continuing the partial as the same message so tools never re-run. One
  attempt per turn: a second overflow, a failed compaction, or nothing
  left to compact ends the turn with a plain operator message. Ruling
  2026-10-04: no deterministic fallback summary — the summarizer is the
  conversation's own model, so when it can't summarize the turn can't
  answer either, and a degraded summary silently harms every later turn.
- **Provider-filter recovery** (2026-10-05): one automatic retry per turn,
  same model, unchanged request, no fallback. Only explicit signals qualify:
  the SDK's `content-filter` finish reason or the verbatim provider warning
  reported by the operator; ordinary assistant refusals are not inspected.
  HTTP rejections and stream errors share the SDK's callback-directed
  step retry (`streamRetries: 0`), preserving earlier tool results and
  buffering the current attempt's tool parts until it ends cleanly. The
  model-boundary adapter also discards filtered tool parts on exhaustion
  (the SDK otherwise flushes them on terminal failure). Cancellation
  cleanup errors are logged without replacing the original filter signal.
  Never restart the turn or re-run completed actions. The retry budget
  survives overflow compaction. The first error stays out of Telegram,
  app streams, history and retention; a second filter ends the turn with
  a plain explanation. Already-streamed partial text/reasoning cannot
  be retracted and stays visible and in UI history; the SDK excludes it
  from its recovered model-step result. While buffering tool-input parts,
  the wrapper keeps pulling upstream until it can emit a part or finish:
  returning from `pull()` without enqueueing can strand a pending read
  forever (chunked-tool regression, 2026-10-05). Keep token streaming live rather
  than buffering whole answers. No prompt rewriting or cache-busting.
  Log retry, recovery and exhaustion. Recovered-step usage excludes
  blocked attempts; log reported filtered-finish usage separately.
  Unreported billing remains unknown. Ordinary transport retries retain
  their existing SDK policy. Cache reuse and blocked-request charges
  are provider-dependent. The pasted warning is real operator evidence;
  its underlying HTTP/SSE envelope remains unverified.
- **Capabilities**: don't hand-maintain a matrix. Use what the SDK exposes on
  model objects (`supportedUrls`, unsupported-feature warnings) plus the
  `models.dev` catalog for per-model input modalities (image/audio/document),
  which is what other agent tools already do.
- **Content**: the payoff — AI SDK takes image, document, and audio parts.
  Telegram media is saved to `attachments/` and stored in history as a
  `data-attachment` part (path + metadata, no payload). Each part's
  representation — file part vs text reference (transcript first for
  speech) — is a pure function of the stored ref and the conversation's
  model **and provider pipe**: file part when the model consumes the
  media type (catalog modalities), the pipe can deliver it
  (`carriesMedia`, `src/agent/providers.ts` — the SDK converter's
  expressible surface, per kind and position — user-message content
  and tool results are different converter paths), and the payload
  fits the per-item inline cap, reference otherwise. Two gates because
  the catalog and the pipe disagree in practice: models.dev said
  glm-5.3-flash takes PDFs while `@ai-sdk/openai-compatible` < v3
  threw `UnsupportedFunctionalityError` on any non-image file part —
  catalog truth alone cost a thrown turn. One carve-out:
  audio only inlines when the ref is marked `speech` — a voice or video
  note. Attached audio is data (Transcription, below); an mp3's bytes in
  every request is the most expensive way to not listen to it. Pure means stable:
  the same history under the same model materializes to the same request
  bytes every turn (see Cache stability). A model switch recomputes
  representations once — legitimate, because a model switch is already a
  cold cache. Only disk failure (file gone) degrades an item that would
  have inlined, with a warn.
- **Cache stability** — moved to the core: DESIGN.md → Cache stability.
- **Transcription**: voice notes and video notes are speech — the two
  media kinds Telegram only produces by recording someone — and a model
  that can't consume audio shouldn't lose them to a bare path. Attached
  audio (`audio`, audio-mime `document`) is data, not speech: an mp3
  meant for `ffmpeg` shouldn't pay whisper for lyrics, so it is never
  transcribed eagerly and never inlines (the `speech` marker above).
  On-demand transcription of attached audio is the `transcribe` tool's
  job — same provider, same segmentation, called deliberately.
  When `transcription` is configured (`kind: groq`, whisper `model`, `auth`
  ref — other kinds slot in as the SDK grows transcription providers),
  intake transcribes the saved recording once and stores the text inside
  the `data-attachment` part. Eager, not per-turn: the transcript is
  durable history, and materialization prefers it over the path
  reference whenever the file can't go inline — wrong modality or spent
  budget — while audio-capable models still get the file part. The call rides the
  per-conversation intake chain (off the update hot path), bounded at 60s
  per call. Files over the provider's 25 MiB upload cap are segmented, not
  skipped: ffmpeg extracts the audio track to mono opus — a video note's
  payload is mostly pixels — and splits it into 15-minute chunks,
  transcribed sequentially and joined; a partial result is kept and
  warn-logged rather than discarded. ffmpeg presence is probed at boot
  when transcription is configured, and install.sh warns when the config
  names it but PATH lacks it. A failed transcription — whisper down,
  ffmpeg missing, corrupt media — leaves the attachment path-referenced
  and warn-logged: it must never eat a voice message.

## No step budget — loops are caught, not capped

Ruling 2026-10-07 (second, supersedes the same-day "soft budget +
watchdog" ruling and its removal). Operator intent, stated plainly: **a
turn has no step budget.** Current models work reliably on one task for
hours; a step count is a design constraint dressed as a safety net, and
the scaffold-era `MAX_STEPS = 25` cliff already ate one whole reply (the
Safari Zone turn: 25 steps of ROM diffs, `finish=tool-calls`, zero
prose). The first ruling raised the cap to 64 *and* added the system1
watchdog — keeping the cap is what made the watchdog look redundant, and
the removal (`7d9e1dc`) judged the half-built thing. The watchdog was
always meant to *replace* the cap.

What bounds a turn now, in order of who fires first:

**1. The repeat detector (deterministic, always on).** Ported from
openclaw's `src/agents/tool-loop-detection.ts` — the mechanism, not its
eight detector kinds. Every completed tool call records
`argsHash = sha256(tool + stable-JSON(input))` and
`resultHash = sha256(stable-JSON(output | errorText))` (full values,
not truncated). Over the turn's last 40 records, the count of records
matching the newest `(argsHash, resultHash)` pair: **10 warns, 20 cuts.**
Same call *and* same result is the definition — a re-run whose output
changed is progress, and an A↔B edit/revert ping-pong with stable
results trips it too (each side reaches 20 inside the 40-window). It
needs no model and works when system1 is down. Deliberate polling with
an unchanging result is the known false positive; the warning tells the
model to wait longer between checks, and 20 identical answers is a
genuinely stuck wait.

**2. The loop watchdog (system1, for what a hash can't see).** Every 16
completed tool calls, system1 scores one noul question (`stuck`,
`src/loop-watchdog.ts`) over the operator's request plus the last 24
calls with args and results (300 chars each) — its own ring, independent
of `reviewer.evidence` (prod caps that at 8, which is why v1's evidence
was thin). The question is worded for *non-convergence*: rephrased
searches returning the same nothing, cosmetic retries of the same
error, cycling approaches — the exact cases v1's wording excluded.
**≥0.7 warns; a second consecutive ≥0.7 cuts; a sub-threshold check in
between resets.** Async and fail-open (an unavailable system1 logs and
skips; the detector still stands), one check in flight at a time,
wired from the shared JevClient (reviewer-enabled is the switch).

Calibration (`scripts/loop-calibrate.ts`, 2026-10-07: the six longest
stored tool turns plus six synthetic cases, three runs each —
deterministic per input):

| | progress cases (max) | stuck cases (min) | MCPi flail @16 |
|---|---|---|---|
| `inception/mercury-decide:free` (prod) | 0.085 | 0.963 | 0.963 |
| `typesafe/jev-1.13` (fallback) | 0.22 | 0.97 | 0.54 |

0.7 sits in the gap for both. The MCPi turn (16 searches for variants
of an unannounced project) scores stuck on the prod model — correctly:
the right outcome there was the warning ("stop searching, report what
you know"), which is exactly what warn-first delivers. The sample is
small and no real turn has exceeded 28 calls; rerun the script when a
long turn lands, and re-calibrate before changing either model.

**3. The context landing.** When a step's reported input tokens reach
85% of the model's catalog context window, the next step is the
tools-off landing. With no budget, an overflow is the one remaining way
a long turn could die without an answer — the overflow resume runs once
per turn and the in-flight reply itself isn't compactable (compaction
cuts stored history; the partial isn't stored until the turn ends).
Landing at 85% ends the turn with prose and a "continue" handoff
instead. Measured headroom today: ~700 input tokens per tool call
(the 28-call Safari turn finished at 24k on a 1M window), so this is
the physical bound on a turn, not a practical one. In-turn compaction
of the partial is deliberately not built; revisit when a context
landing shows up in the log.

**4. The operator.** `/stop` is the backstop for everything above.

**Escalation: warn, then cut.** A warning is a request-only user message
appended once at the next step boundary, tools still on ("change
approach, or stop and report what's blocking you"). The SDK carries a
`prepareStep` message override forward, so the warning stays in context
for the rest of the turn without being re-appended — appended at the
tail, cache-neutral. A cut is the tools-off landing: `toolChoice:
"none"` plus a kind-specific request-only nudge, and a stop condition
that ends the loop after that one step (no step count; `stopWhen`
otherwise is `isLoopFinished()`). Nudges never land in durable history.
Every warn, cut, and verdict logs (`loop detector`, `loop watchdog`,
`context landing`) with the counts and scores that explain it.

The invariant stands: **a turn always ends in an answer**, and the log
explains every early landing.

**Forced answers are stamped, not passed off as natural.** A landing
sets `forcedCompletion: "repeat" | "watchdog" | "context"` in the finish
chunk's message metadata (the `TurnMetadata` wire type, shared with the
app client), and the app's turn footer renders it ("loop detector —
answer forced", "loop watchdog — answer forced", "context nearly full —
answer forced"). An answer produced under "tools are disabled, answer
now" is degraded goods — the operator sees that it is, on the message
itself, live and on history reload.

**Every reading surface carries the stamp.** The app channel reads it
from turn metadata (footer line); Telegram has no footer, so the stamp
joins the reply body itself at `onDone` — riding the status-tail mark,
so the final flush publishes it on the last bubble (🫡 lands on the
stamped message) and TTS never speaks it; voice turns ship it as its
own notice line after the audio. The mini app is the settings surface,
not a chat — no stamp there by design. `TurnDone` carries the same
`forced?` kind so any future delivery surface inherits the contract.

**Carried from the first ruling's review round.** Detector records and
watchdog state ride `TurnRecovery` across an overflow resume — one
logical turn, one loop history. A steer whose every conversion fails at
the landing step does not eat the landing (the poison-pill return
carries `toolChoice: "none"` + nudge). And a provider that defies
`toolChoice: "none"` — still emitting tool calls on the forced step, or
no prose at all — gets a synthetic plain-language answer per kind,
appended to the stored message and the live delta path, warn-logged.
The stamp never lies about a nothing.

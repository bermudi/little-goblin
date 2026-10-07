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
  rows. `openStore` migrates bare (pre-envelope) rows once; reads accept
  both shapes.
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
  no pointer is written, the crossing retries. Auto-compaction runs inside the conversation's serial
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

## The turn budget lands soft — and system1 watches the loop

Ruling 2026-10-07, operator ask, from a failed turn. Symptom: a deep
exploration turn (Safari Zone mechanics from ROM disassembly diffs) ran
25 steps, hit the scaffold-era `MAX_STEPS` cliff with `finish=tool-calls`,
and ended with **no reply at all** — 25 tool calls of findings, zero
prose, no notice to operator, model, or log. Two rulings landed:

**The budget is a safety net, not a design constraint — and it lands
soft.** `STEP_BUDGET` (64; `deps.stepBudget` for tests) still bounds the
loop — an unbounded agent loop is a runaway cost loop, and no harness
worth copying runs without one — but the step *after* the budget locks
`toolChoice: "none"` and appends a request-only user nudge ("write the
final answer now"), so a spent budget forces an answer instead of
truncating. `stopWhen` allows exactly that one extra step. The nudge is
user-role and never lands in durable history.

**The loop watchdog was built (2026-10-07) and removed same day.**
The idea — system1 scoring the digest ring "is this looping?" every 16
tool calls — died on contact with the evidence: across the 84-turn log
only four turns ever reached 16 calls, none repeated a call exactly,
and the one flailing turn (19 searches for variants of a nonexistent
thing) is exactly the case the question wording excluded ("many
similar-looking but distinct commands are NOT looping"). What remained
for a model to judge was near-exact repetition — which a hash does
deterministically. Worse, prod config (`reviewer.evidence.calls: 8`)
capped the ring below the evidence depth the 16-call cadence commit
itself called necessary, and a false positive would cut precisely the
deep turns the budget raise was meant to protect. **Ruling: no model
judges repetition mid-turn. If a real loop ever shows in the log, the
tool is a deterministic detector — the same `(tool, args)` hash seen K
times in a turn triggers the existing tools-off landing and reuses the
`forced` stamp channel (widen the kind then: `"budget" | "repeat"`).**
Do not re-propose the JevClient version.

The invariant that stays: **a turn always ends in an answer** —
whatever the budget or the provider does, the operator gets prose, and
the log explains every early landing.

**Forced answers are stamped, not passed off as natural.** A budget
landing sets `forcedCompletion: "budget"` in the finish
chunk's message metadata (the `TurnMetadata` wire type, shared with the
app client), and the app's turn footer renders it: "step-budget cap —
answer forced". An answer produced under "tools are disabled, answer
now" is degraded goods — the operator sees that it is, on the message
itself, live and on history reload.

**Every reading surface carries the stamp.** The app channel reads it
from turn metadata (footer line); Telegram has no footer, so the stamp
joins the reply body itself at `onDone` — riding the status-tail mark,
so the final flush publishes it on the last bubble (🫡 lands on the
stamped message) and TTS never speaks it; voice turns ship it as its
own notice line after the audio. The mini app is the settings surface,
not a chat — no stamp there by design. `TurnDone` carries
`forced?: "budget"` so any future delivery surface
inherits the contract.

**Review round, same day (fresh-context reviewer): three holes closed.**
The budget is *per-attempt* — an overflow compact-and-resume starts a
fresh counter, so one logical turn is bounded at 2×(STEP_BUDGET+1);
accepted (one recovery per turn, overflow+deep-loop coincidence).
A steer whose every conversion fails at the budget step no longer eats
the forced landing (the poison-pill return carries it too). And a
provider that defies `toolChoice: "none"` — still emitting tool calls
on the forced step, or no prose at all — gets the invariant's last
word: a synthetic plain-language answer ("I hit the step budget before
writing my answer… say 'continue'") appended to the stored message and
the live delta path, warn-logged. The stamp never lies about a
nothing.

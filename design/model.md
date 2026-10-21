# Model layer — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Model layer

- **Provider facts.** z.ai's coding plan serves only 5.3-gen models, aliasing
  older glm-* ids to them (Thinking). Logfare's docs note requests may be
  PII-scrubbed and logged for eval. The Codex CLI-wrapper can't drive our
  loop (no caller tools); our adapter must write the CLI's rotated refresh
  tokens back, or it invalidates the CLI's own login.
- **Selection scope (2026-10-06).** Telegram uses one shared selection across
  all DMs/topics, and root-default changes must never leak into it. Admission
  freezes a turn's settings (capability gates included) through overflow
  retry and compaction. Summaries use the conversation's model and thinking;
  reviewer fallback uses the conversation's model; explicit reviewer and
  title models stay independent.
- **Thinking (ruling 2026-10-21).** `off|minimal|low|medium|high|xhigh|max` is
  an operator vocabulary, not a provider contract. Every model has one
  **profile** — the rungs it supports, what `off` means on it, and the wire
  knob that carries a rung (`src/agent/thinking.ts`). The ladder the app
  offers IS the profile: a level a model cannot express is never offered.
  `glm-5.3` offers `low|high|max` — no `off`, no `medium`, no `xhigh`;
  `minimax-m3.1-flash` offers `low|medium|high|xhigh|max` and no `off`,
  because its reasoning is mandatory. `off` is offered only when it
  genuinely switches reasoning off; a stored `off` on a model that cannot
  disable reasoning clamps to its weakest rung, because a mandatory model
  answers a disable with "Reasoning is mandatory for this endpoint and
  cannot be disabled" (probed on minimax-m3.1-flash, minimax-m2 and
  deepseek-r1-0528). Stored values outside a model's set aren't errors —
  defaults span models — so the mapping clamps to the nearest rung
  at-or-above (GLM's own collapse direction).
  Sources, in order of honesty: OpenRouter's cached `/models` catalog
  reads the per-model `reasoning` object (`supported_efforts` → the rungs,
  `mandatory` → whether `off` can exist; `none` in `supported_efforts` is
  the disable); z.ai GLM and the OpenAI/codex families use the vendor's own
  tables — GLM (docs.z.ai): 5.3+ forced thinking, effort `low|high|max`
  (unlisted values silently become `max`); 5.2 toggles plus `high|max`, ≤4.6
  toggles only; the coding-plan alias gives every glm the 5.3 ladder.
  GPT/codex takes `reasoning_effort` verbatim on `low|medium|high|xhigh`
  (gpt-6 adds `max`); `off` isn't a rung and clamps to the floor. An
  unknown route (cold catalog, unlisted model, dynamic router) keeps the
  whole vocabulary and sends no reasoning knob at all for `off` — the
  route's default — because a disable we cannot back is a failed turn:
  fail loud, never fake knowledge.
- **History.** Rows stamp the format that wrote them — the SDK owns the part
  shapes — so a future shape change is a deliberate converter at open, never
  silent placeholder degradation of old rows; a straggler that skips the
  envelope degrades to a placeholder, never parses as speech. Arrival seq
  stays the truth; the model view anchors each reply so none reads as having
  seen later input.
- **Compaction.** History is unbounded on disk, bounded in the window by
  pointer relocation, never deletion. A completed turn crossing most of its
  model's catalog window — or `/compact` — compacts: the conversation's own
  model summarizes (a sloppy summary silently degrades every future turn,
  and it runs rarely) from the previous boundary to a completed-exchange cut
  — the causal-view rule, so a response is never orphaned from its user
  message — keeping a recent tail in budget. An interleaved burst is atomic,
  so the cut coarsens to whole bursts. Summarizer input is the delta since
  the previous boundary plus the previous summary, never the whole past, so
  each call is bounded by one compaction interval; within it, chunks run
  sequentially carrying the running summary, an oversized event truncated
  rather than stalling the fold, each call racing a timeout — a wedged
  request must settle, a timeout is ordinary. The summary lands as a row and
  the event stream stays untouched and queryable forever. Recovery is named,
  not implied (ruling 2026-10-14): the summary marker carries the
  conversation id and boundary seq and points at `history_search`
  action=context, so the folded span stays pageable; no folded-span dump
  file — the event stream already is the record, and a copy would drift.
  The model view is the summary plus events at their causal position, so a
  late answer to a folded question rides into the summary; the requestHash
  move is the sanctioned boundary (Cache stability). Failure is loud and
  lossless: a failed call writes no boundary and warns, and the next
  crossing retries — as does an abort by `/stop` or shutdown. An
  epoch-bumping settings change (the authority rule) fences the same
  commit: the re-check runs before each chunk and before the pointer lands,
  so a fence spends no further calls and clears no frozen prompt snapshot —
  the crossing retries under the new settings. Auto-compaction runs in the
  serial lane after the turn's sinks are notified — the reply lands first;
  `/compact` serializes through it and still compacts with the window
  unknown (a forced scrub). Ruling 2026-10-19: the window lookup is
  metadata, not a model step — `compaction.contextWindow` reads the
  catalog only, so a compaction pass resolves no auth, builds no model
  step, and can never mint or rewrite a frozen prompt snapshot;
  `buildStep` alone builds prompts and only a landed boundary clears
  the snapshot. The utilization warn stays as the alarm that
  compaction didn't happen or didn't keep up.
  A mid-turn **context-overflow error** is a recovery, not a failure
  (mechanism from pi): the partial reply is held off the wire, one
  compaction runs with a smaller tail (the overflow proved the estimate
  optimistic), and the turn resumes on the compacted view, continuing the
  partial as the same message while the journaled calls ride the recovery
  guard — a colliding effectful re-ask refuses, safe reads re-observe,
  operator grants spend once; one attempt per turn,
  else a plain operator message. Ruling 2026-10-04: no deterministic
  fallback summary — the summarizer is the conversation's own model, so
  when it can't summarize the turn can't answer either, and a degraded
  summary silently harms every later turn.
- **Provider-filter recovery** (2026-10-05): one automatic retry per turn,
  same model, unchanged request, no fallback; only explicit signals qualify —
  the SDK's `content-filter` finish reason or the operator-pasted provider
  warning; ordinary refusals are not inspected. Never restart the turn or
  re-run completed actions; the budget survives overflow compaction. The
  first error stays out of Telegram, app streams, history and retention; a
  second filter ends the turn with a plain explanation; already-streamed
  partial text can't be retracted. The buffering wrapper must keep pulling
  until it can emit or finish — a `pull()` that returns without enqueueing
  strands a pending read forever (chunked-tool regression, 2026-10-05) — and
  token streaming stays live: no whole-answer buffering, no prompt
  rewriting, no cache-busting. Recovered-step usage excludes blocked
  attempts; the pasted warning is real operator evidence, its HTTP/SSE
  envelope unverified; unreported billing is unknown, and cache reuse and
  blocked-request charges are provider-dependent.
- **Capabilities**: no hand-maintained matrix — the SDK's model objects plus
  the `models.dev` catalog for input modalities.
- **Content**: each part's representation — file part vs text reference
  (transcript first for speech) — is a pure function of the stored ref and
  the conversation's model **and provider pipe**, so the same history
  materializes to the same request bytes every turn (Cache stability); a
  model switch recomputes once, legitimate because it is already a cold
  cache. A file part takes all three: catalog modality, pipe deliverability,
  per-item inline cap; otherwise a reference. Two gates because catalog and
  pipe disagree: models.dev listed glm-5.3-flash PDFs while
  `@ai-sdk/openai-compatible` < v3 threw `UnsupportedFunctionalityError` on
  any non-image file part. One carve-out: audio inlines only when the ref is
  marked `speech` — a voice or video note; an mp3's bytes in every request
  is the most expensive way to not listen to it. Only disk failure (file
  gone) degrades an item that would have inlined, with a warn.
- **Cache stability** — moved to the core: DESIGN.md → Cache stability.
- **Cache contracts.** Each provider kind/base-URL family maps to a reviewed
  contract — cache mode, lifetime class, public sources — with its review
  date; doctor surfaces the mapping; the bounded re-check is manual, public
  docs only, never edits policy. The gaps are admitted: z.ai publishes no
  retention, OpenRouter's 10-minute routing affinity is not cache expiry,
  the Codex backend's retention is unverified, an OpenAI-compatible relay
  establishes nothing about its upstream. Contracts plus cache-call
  telemetry feed drift diagnosis and the opt-in pruning gate (DESIGN.md →
  Cache stability): a `cachePruning` profile's `evidence` label separates
  `documented-expiry` — valid only where the registry records a
  rolling-expiry contract the profile respects — from `empirical`, the
  operator's own measurement. Z.AI-class unpublished lifetimes carry
  empirical profiles only; an empirical profile is a measurement, never a
  provider guarantee, and must never be presented as one.
- **Transcription**: voice and video notes are speech — Telegram produces
  these only by recording someone — and a model that can't consume audio
  shouldn't lose them to a bare path: with transcription configured, intake
  transcribes once and stores the text with the attachment ref (eager, not
  per-turn: the transcript is durable history; materialization prefers it
  over the path whenever the file can't go inline, while audio-capable
  models still get the file part). The call runs off the hot path, bounded
  per call by the engine's timeout. Attached audio is data, not speech: an
  mp3 meant for `ffmpeg` is never transcribed eagerly and never inlines;
  on-demand transcription is the `transcribe` tool's deliberate job. Files
  over the upload cap are segmented, not skipped; a partial result is kept
  and warn-logged. A failed transcription — provider down, ffmpeg missing,
  corrupt media — leaves the attachment path-referenced and warn-logged: it
  must never eat a voice message. ffmpeg presence is probed at boot when
  configured, and install warns when the config names it but PATH lacks it.

## No step budget — loops are caught, not capped

Ruling 2026-10-07 (operator): **a turn has no step budget.** Current
models work reliably on one task for hours; a step count is a design
constraint dressed as a safety net — the scaffold-era `MAX_STEPS = 25`
cliff already ate a whole reply (the Safari Zone turn: 25 steps of ROM
diffs, `finish=tool-calls`, zero prose).

What bounds a turn, in order of who fires first:

**1. The repeat detector (deterministic, always on).** Ported from
openclaw's `tool-loop-detection.ts` — the mechanism, not its
eight-detector taxonomy. Same call *and* same result is no progress (a
changed result is progress; an A↔B ping-pong with stable results trips it
too); it needs no model, so it works when system1 is down. Deliberate
polling with an unchanging result is the known false positive — the
warning says to wait longer between checks.

**2. The loop watchdog (system1, for what a hash can't see).** system1
periodically scores the operator's request plus the recent calls against
a *non-convergence* question: rephrased searches returning the same
nothing, cosmetic retries of the same error, cycling approaches. **A
stuck score warns; a second consecutive stuck score cuts; a sub-threshold
check in between resets.** Async and fail-open (an unavailable system1
logs and skips; the detector still stands), one check in flight, wired
from the shared System One client (design/system1.md); its ring is
independent of the reviewer's shallower evidence ring.

Calibration (`scripts/loop-calibrate.ts`, 2026-10-07: six longest stored
tool turns + six synthetic cases, three runs each, deterministic per
input):

| | progress cases (max) | stuck cases (min) | MCPi flail @16 |
|---|---|---|---|
| `inception/mercury-decide:free` (prod) | 0.085 | 0.963 | 0.963 |
| `typesafe/jev-1.13` (fallback) | 0.22 | 0.97 | 0.54 |

The threshold sits in the gap for both; the MCPi turn (16 searches for an
unannounced project) scores stuck on the prod model — correctly. Small
sample, no real turn over 28 calls: rerun when a long turn lands,
re-calibrate before changing either model.

**3. The context landing.** With no budget, an overflow is the one
remaining way a long turn dies without an answer — the in-flight reply
isn't stored until the turn ends, so it isn't compactable. A step whose
reported input nears the catalog window lands tools-off — the turn ends in
prose and a "continue" handoff. Measured headroom: ~700 input tokens per
tool call (the 28-call Safari turn finished at 24k on a 1M window) — the
physical bound on a turn, not a practical one. In-turn compaction of the
partial is deliberately not built; revisit when a context landing shows
up in the log.

**4. The operator.** `/stop` is the backstop for everything above.

**Escalation: warn, then cut.** A warning is a request-only user message
appended once at the next step boundary, tools still on ("change
approach, or stop and report what's blocking you"), carried forward by
the step-messages override — tail-appended, cache-neutral. A cut is the
tools-off landing with a kind-specific nudge; nudges never land in
durable history. Every warn, cut, and verdict logs with the counts and
scores behind it.

The invariant stands: **a turn always ends in an answer**, and the log
explains every early landing.

**Forced answers are stamped, not passed off as natural.** A landing
stamps which bound fired into the finish metadata shared with the app
client; the app footer renders it, live and on history reload — an
answer produced under "tools are disabled, answer now" is degraded goods,
and the stamp says so. Every reading surface carries it: Telegram
appends it to the reply at completion, riding the status tail, never
spoken by TTS; voice turns ship it as a notice line after the audio; the
mini app has no chat, so no stamp there by design; the terminal done
signal carries the same forced kind, so future surfaces inherit the
contract.

**Review-round rulings (2026-10-07).** Detector records and watchdog
state ride the turn's recovery across an overflow resume — one logical
turn, one loop history. A steer whose every conversion fails at the
landing does not eat the landing (the poison-pill return keeps the
tools-off landing). A provider that defies the tools-off step — still
emitting tool calls, or no prose — gets a synthetic per-kind
plain-language answer appended to the stored message and the live delta,
warn-logged. The stamp never lies about a nothing.

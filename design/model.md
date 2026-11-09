# Model layer — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Model layer

- **Provider facts.** z.ai's coding plan serves only 5.3-gen models, aliasing
  older glm-* ids to them (Thinking). Logfare's docs note requests may be
  PII-scrubbed and logged for eval. The Codex CLI-wrapper can't drive our
  loop (no caller tools); our adapter must write the CLI's rotated refresh
  tokens back, or it invalidates the CLI's own login.
- **1min.AI relay (2026-10-22).** The `openai-compatible` kind serves
  `https://api.1min.ai/openai/v1`; its pipe truths are pinned in
  `src/agent/onemin.ts` from the operator-supplied docs
  (docs.1min.ai/docs/api/openai-compatible), following the z.ai
  precedent of host-scoped relay truth. Three of them change wire
  behavior: the endpoint is **text-only for every model it lists**
  ("including models with vl in their names") — the carrier gate
  rejects all media by host, so attachments stay path references and
  the vision tool answers image questions in auto mode even when the
  catalog's scan-fallback claims the model id sees images;
  **`reasoning_effort` is OpenAI reasoning-models-only** — "OpenAI GPT-5,
  GPT-6, and o3 models accept reasoning_effort" (value set
  none|minimal|low|medium|high|xhigh — no `max`): the older
  non-reasoning OpenAI ids (gpt-3.5/4/4.1/4o) join GLM, DeepSeek, Qwen,
  Mistral, Kimi and Muse Spark in sending no knob at all and offering
  only the "off" the relay's default backfills, while GPT-5.6* and
  GPT-6 Sol/Luna — which demand `none` whenever a request carries
  tools or tool history, and the loop always defines tools — offer the
  disable alone (the review call carries tools too, so it rides the
  same options on 1min routes); and **every POST is a billed
  generation**, so all chat calls (turn steps, compaction summaries,
  reviews, titles, vision answers) carry `maxRetries: 0` — the SDK
  default of 2 would be a silent double charge. One deliberate
  exception survives on purpose (model.md → Provider-filter recovery):
  the one-shot content-filter re-ask — a blocked request reports no
  output tokens, so the retry spends roughly one input pass, bounded
  and logged. Streaming asks for
  `include_usage` (the relay reports usage only under it), and
  `gpt-6-astra` can't serve as a chat model (it rejects function
  tools — fail loud, 400). Request caps live upstream and are not
  compensated: 200 messages, 100,000 total characters, a 32,768-token
  output cap, a two-minute generation deadline, 60 requests/minute —
  a 400/429 fails loud. The character cap is the practical wall:
  ~100k characters is ~25k tokens, so a long conversation breaches it
  long before its model's token window, and compaction (token-driven)
  cannot prevent the 400 — `/compact` proactively if 1min models run
  the long lanes. The offered effort ladder is the relay's union
  value set ("accepted values vary by model"); a model that rejects a
  rung answers with a provider parameter error — fail loud, the
  per-model value sets are not published anywhere goblin can read. The
  relay has no models.dev entry, so the settings picker shows no
  model list — the typed-ref fallback carries, context windows arrive
  via the catalog's scan-fallback from the serving providers. Cache
  contract: reviewed-unknown — the relay publishes no prompt-cache
  lifetime, and upstream caching does not carry through the relay.
- **Selection scope (2026-10-06).** Telegram uses one shared selection across
  all DMs/topics, and root-default changes must never leak into it. Admission
  freezes a turn's settings (capability gates included) through overflow
  retry and compaction. Summaries use the conversation's model and thinking
  (and its fallback list, see "Model fallback list" below);
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
- **Output headroom (ruling 2026-10-29).** Reasoning tokens count toward
  the provider's output cap on every wire goblin drives — no endpoint
  offers a "don't count thinking" knob (probed on z.ai's Responses door:
  `output_tokens` covers `reasoning_tokens`; OpenRouter's
  `reasoning.max_tokens` bounds the same envelope, it doesn't exempt
  it). So a call that caps output sends **answer budget + headroom for
  the rung the wire actually carries** (`outputTokensFor` in
  `src/agent/thinking.ts`): a real disable adds nothing, a floored `off`
  buys its weakest rung's room, and anything that still reasons without
  a knob the wire took — an unknown route, a no-knob relay default, a
  Responses-door glm "off" that lands on `low` because the shape has no
  disable — hedges at `low`. The per-rung ladder (1k at `minimal`
  doubling to 32k at `max`) is
  a calibrated guess, not provider truth; the sum is capped at 65_536,
  inside every endpoint's accepted output (models.dev lists glm-5.3 at
  131k). Applies to the bounded calls — vision and note rewrite — not
  turn steps, which carry no output cap.
- **Codex model catalog (ruling 2026-11-01).** models.dev has no codex
  key and the kind carries no baseUrl to host-match, so the picker's
  codex list comes from the ChatGPT backend itself:
  `GET /backend-api/codex/models?client_version=<semver>` with the
  responses call's own headers (probed 2026-11-01). `client_version`
  is a server-side capability gate — each row's
  `minimal_client_version` decides whether it lists at all (0.62
  answers 200 with an empty list) — so `CODEX_CLIENT_VERSION` pins the
  CLI generation the adapter's wire shape was written against and
  bumps deliberately, never to silence an empty list. The catalog is
  account-scoped: one `createCachedCatalog` per resolved auth file,
  cache `state/codex-models-<path hash>.json`, TTL/backoff shared with
  the other catalogs via the skeleton's `requestHeaders` hook (the
  Bearer resolves per fetch so a token rotation can't strand it).
  Offered rows are `visibility:"list"` + `supported_in_api` — "hide"
  lanes (gpt-reserve, codex-auto-review) stay out — sorted by the
  wire's `priority`. `context_window`, `input_modalities` and
  `supported_reasoning_levels` ride the stored record for the gauge,
  attachment and per-model thinking follow-ups, not yet consumed
  ("ultra" sits outside the thinking vocabulary entirely).
  `GOBLIN_CODEX_LIVE=1 bun test src/agent/codex/models.live.test.ts`
  pins the contract: endpoint, headers, gate.
- **History.** Rows stamp the format that wrote them — the SDK owns the part
  shapes — so a future shape change is a deliberate converter at open, never
  silent placeholder degradation of old rows; a straggler that skips the
  envelope degrades to a placeholder, never parses as speech. Arrival seq
  stays the truth; the model view anchors each reply so none reads as having
  seen later input.
- **Zhipu Responses replay is stateless (ruling 2026-11-04).** The SDK's
  Responses converter defaults `store` to true and substitutes an
  `item_reference` for every assistant part carrying `openai.itemId`, so
  prior prose reaches the provider only as ids it must resolve — the
  conversation-recall audit found assistant prose absent from the model's
  reported view; failed reference resolution is the leading suspect, not
  provider-verified. The `zaiStatelessReplay`
  middleware wraps only `api.z.ai` responses models and forces
  `openai.store:false` at `transformParams` — the canonical `openai`
  namespace, which the converter reads regardless of the config provider's
  name — so text and tool items always replay inline and no reliance is
  placed on provider-stored item references. The pre-conversion context
  window capture is not wire proof; what the SDK emits is the contract.
  Reasoning parts without encrypted content may be omitted by the SDK when
  store is false — prose must remain, cipherless reasoning may not.
- **Codex reasoning persistence.** Codex sends `store:false`, so reasoning
  continuation is our problem: the adapter stamps each response item's
  replay state into `providerMetadata.codex` — `itemId` + `replayScope` on
  every replayable item, `reasoningEncryptedContent` on reasoning,
  `phase` on message items — and `convertPrompt` rebuilds the wire items
  (`reasoning` at its own position, `id`/`phase` on messages and function
  calls) only when the scope proves the same model+account
  (`sha256([modelId, account_id ?? authFile])`). Anything else drops the
  metadata with a warning: foreign or malformed namespaces, scope
  mismatches, cipherless reasoning — a bare summary is never substituted
  for encrypted state, and the opaque values never enter logs, summaries,
  or instructions. The `doGenerate` path collects content in streaming
  order (interleaved reasoning/text/calls, metadata from start and end
  parts), and an empty-summary reasoning item still emits a part — the
  cipher is the payload, the summary is optional evidence. Resume
  ordering follows the same rule the checkpoint walked: step-ordered
  text/reasoning with their providerOptions, journal-backed tool parts at
  their own positions, `step-start` boundaries so each step's tool
  results land before the next step's reasoning and text, and
  uncheckpointed journal calls appended once at the tail. Because the
  cipher counts as bytes in `JSON.stringify`, the compaction estimate
  exempts exactly `providerMetadata.codex.reasoningEncryptedContent`
  (call/result metadata included) — everything else counts as before.
- **Codex session affinity & receipts.** Cache affinity rides a derived
  session id — `sha256("goblin-codex-session:<convId>")` rendered as a
  UUID, never the raw conversation id — sent as `session-id` +
  `thread-id` headers and body `prompt_cache_key`; absent when no
  session was given. `x-codex-turn-state` is captured once per model
  instance (first non-empty response header wins, echoed on every later
  request the instance makes) — one instance is one turn attempt, so
  it never crosses turns. Compaction's summarizer marks itself
  `x-openai-subagent: compact`. Rate-limit receipts land on the finish
  part's `providerMetadata.codex` (the `codex.rate_limits` SSE event
  overrides the header snapshot) and the `response-metadata` part; the
  turn keeps the newest non-null quota into `TurnMetadata` and the
  live `data-context` part, and the gauge's popover shows 5h/weekly
  windows only when issued. Logs carry percentages and booleans —
  never the turn-state value, tokens, or account id.
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
  the crossing retries under the new settings. Ruling 2026-10-25
  ([compaction](compaction.md) → Timing): the normal fold is now a
  **step-boundary pre-emption** — the trigger (the projected upcoming
  request ≥ the lower of 50% of the window and 128k) is checked at the
  `prepareStep` seam before every model call, gate-checked for foldable
  stored history, and when it fires it
  stops the next dispatch, folds mid-turn, and resumes the
  turn on the compacted view through the overflow rail (full tail,
  reason `preempt`; it consumes the turn's one fold-resume; a context
  landing at the same boundary retracts in its favor). The serial-lane
  end-of-turn fold stays as the backstop when pre-emption could not or
  did not fire, and `/compact` serializes through it and still compacts
  with the window unknown (a forced scrub). Ruling 2026-11-09 ([compaction](compaction.md)):
  the two arms became one trigger and the tail 20k (built, #399); cuts
  that split a turn (#403) and the summary's required headings, audit
  and code-made parts are not yet built. Ruling 2026-10-19: the window
  lookup is
  metadata, not a model step — `compaction.contextWindow` reads the
  catalog only, resolving no auth and building no model step, so the
  lookup can never mint or rewrite a frozen prompt snapshot (the
  summary call itself still resolves auth and runs the
  conversation's model; `buildStep` alone builds prompts). The
  snapshot clears only at a boundary that rewrites what the prompt
  must say: a landed compaction, or a persona/memory-exclusion
  switch. A `/compact` fenced mid-lookup — a `/stop` or
  epoch-bumping settings change landing during the read — rejects
  fenced rather than reporting "nothing to compact": the pass
  genuinely lost authority. The utilization warn stays as the alarm
  that compaction didn't happen or didn't keep up.
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
- **Quota walls skip the SDK's retries** (2026-11-01): the AI SDK retries
  only an `APICallError` with `isRetryable === true` and has no skip hook,
  so a z.ai 429 "Limit Exhausted" burned its whole `maxRetries` ladder
  (goblin.log 2026-10-26, "Failed after 3 attempts"). `resolveModel` wraps
  every resolved model in a middleware that rethrows a `quotaExhausted`
  match as the same `APICallError` (all fields kept) with `isRetryable:
  false`, logging one `warn` (model, statusCode, resetAt). Throttles, 5xx
  and overloads keep the SDK ladder; `maxRetries` is unchanged.
- **Model fallback list** (ruling 2026-11-02, operator). The turn is the
  one call that had no fallback, and 2026-10-26 cost ~50 minutes of
  hand-failover (codex `server_is_overloaded`, then a z.ai quota wall).
  The mechanism is design/web.md's fallback chain applied to model refs,
  plus openclaw's `canFallbackAfterError` gate (the walk never replays
  committed work).
  - **Config.** `modelFallbacks: ref[]`, top-level and global, default
    `[]`, edited from app settings as an ordered list (add with the
    model picker, reorder, remove). Each entry is validated like `model`
    (its provider must exist). Goblin ships no list and never infers
    one: an empty list means today's behavior.
  - **Order.** Every turn tries the conversation's own model first
    (app or Telegram selection, unchanged), then `modelFallbacks` in
    order, skipping an entry equal to a ref already tried. The walk
    restarts at the conversation's model on every turn. There are no
    holds, cooldowns or pinning. A quota refusal costs one fast call
    (0.55–1.1 s on 2026-10-26, with no SDK retries since the quota-wall
    ruling above). Any hold's "until" would be a guess: z.ai's reset
    time has no timezone, quota detection matches phrases, and a top-up
    ends a quota early. Revisit if logs show slow failures or noise.
  - **When to advance: zero effect only.** The attempt failed before any
    model call completed (`modelCalls === 0`, the gate both engines
    already keep), before any text or reasoning reached a sink, and
    before any tool was dispatched. Lane-specific setup failures count
    too: auth resolution, or an unbound claude engine. Anything later
    ends the turn as today. **Never mid-loop.**
  - **What does not advance:** abort, authority fences, journal faults
    (any of the attempt's own journal reads or writes — run creation,
    the recovery-guard read, the gate's zero-effect probe — not only a
    fenced tool's), and content-filter (it has its own recovery above). Context overflow
    is never a fallback trigger: it keeps its recovery (compaction plus a
    fresh attempt) on whichever candidate is serving, and the
    continuation stays on that candidate. With compaction unwired the
    overflow ends the turn; it still never advances. (Amended at implementation,
    2026-11-02: "advance on a fallback's overflow" would end a mid-loop
    overflow outright, which is worse than compacting.)
  - **Per-candidate binding.** For one attempt, the candidate stands in
    for `conv.model` everywhere the turn reads it: tools (codex's hosted
    search), view gates (modalities, carries, provider-executed parts),
    thinking clamp (the stored level clamps per ref through the existing
    profile), `maxRetries`, context window, and engine fork. The stored
    selection is never written. The frozen system prompt is
    per-conversation and unchanged. Each ref's request bytes stay a pure
    function of ref plus history, so switching lanes is the sanctioned
    model-switch cold cache, once per switch.
  - **Crossing engines is allowed.** A list may mix AI-SDK and
    claude-code refs. Both engines read the same transcript. The
    claude-code engine replays the whole view each turn with no SDK
    session. Codex hosted parts drop off non-codex views. A fallback
    that lands on claude-code inherits that engine's v1 rulings (steers
    defer to the next turn). **Gate:** a runtime test of one
    conversation that goes AI-SDK turn with tool call → claude-code turn
    → AI-SDK turn lands before mixing ships. No test covered a
    mid-conversation engine switch as of 2026-11-02.
  - **Run row and resume.** The row records the ref it ran on and the
    conversation's configured ref. Resume continues on the recorded ref:
    a resumed turn never switches models. The drift check compares
    configured refs (an operator re-selection still refuses). A recorded
    ref whose provider has since been removed is not refused at resume;
    the resumed turn fails loud at step build instead.
  - **Compaction.** The summarizer walks the same list (its call is
    single, tools-off and non-streamed, so any throw is zero effect).
    This amends "the summarizer is the conversation's own model": it is
    the conversation's lane list. There is still no deterministic
    summary. `runCompaction` owns the walk (amended 2026-11-02, review):
    each candidate's call gets its own timeout, never a parent signal
    pre-armed with it, so a wedged primary times out alone and the next
    candidate starts live; only the parent abort (/stop, a fence) ends
    the walk. Within one pass the walk is sticky — a candidate that
    failed a chunk is not retried on later chunks, so a wedged primary
    costs one timeout, not one per chunk. The stored fold names the ref
    that wrote the final chunk ("folded by" is the server, not the
    selection).
  - **Visibility.** Each advance logs `model fallback` (conversation,
    from, to, failureClass, error). The turn's finish metadata carries
    `servedBy` and the failed refs with short reasons (metadata
    `fallback.from`; the label is the serving ref). A zero-effect error
    is held off the wire while a candidate could follow or earlier ones
    already failed, so the wire shows one error, the final story. The
    app shows it
    under the reply. Telegram appends one line: `via zai/glm-5.3 —
    codex/gpt-6.1-terra: quota exhausted` (search's `served_by`
    pattern). If every candidate fails, one error lists each ref and its
    reason. The scheduler sees `transient: true` only if every
    candidate's failure was transient, so a quota-walled program still
    fails and notifies.
  - **Out of scope:** subagents (pinned), reviewer/title/vision models
    (independent by the selection-scope ruling), per-conversation lists,
    round-robin, health checks.
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
- **Transient transport retries** (2026-11-08, issue #191): a dropped
  connection must not kill a turn that already executed tools. The SDK
  retries only errors it flagged itself (`APICallError` `isRetryable`),
  so a raw fetch `TypeError` / `ECONNRESET` — mid-stream or before the
  first byte — spent nothing and one blip ended the turn (goblin.log
  2026-11-08: 13 completed tool calls, then `provider-error` TypeError
  ECONNRESET). Two surfaces, two bounds, one log line per retry
  (attempt, error, delay):
  - **Mid-stream** — an error part on the provider stream (codex
    surfaces a socket reset there). `driveStream`'s `onError` grants
    the SDK's one callback-requested retry per model step
    (`streamRetries: 0` keeps retries callback-directed) when the
    transient classifier owns the error (`isTransientTurnFailure` —
    never a content filter, quota wall or overflow verdict). Only
    stream-surface errors are granted (tagged in `filterErrorStream`):
    a pre-stream throw bypasses the retry machinery, and a granted
    request the SDK would ignore is a log line lying about a retry.
    The retry re-dispatches the failed step only; earlier steps and
    their tool results are preserved (SDK stream-retry contract), and
    the failed attempt's tool parts were buffered and dropped, so no
    tool runs twice. Delay 2 s (the SDK ladder's `initialDelayInMs`
    default), ended early by abort; recovery logs one line.
  - **Before first byte** — `doStream`/`doGenerate` rejects (raw
    `TypeError`, `ECONNREFUSED`). `resolveModel` wraps every model in
    a transport-retry middleware: the SDK ladder's twin (same envelope
    — the lane's own retry rule, so 1min's billed-every-attempt ruling
    keeps 0; exponential backoff from 2 s) with a different predicate:
    transient throws the SDK will not flag, `APICallError` excluded so
    flagged errors keep the SDK's own ladder and nothing compounds.
    Only the single vendor call retries — completed steps and tools
    are untouched. The raw-throw gap is the codex lane (its own fetch,
    no provider-utils normalization); SDK-native providers normalize a
    failed fetch into an `isRetryable` `APICallError` the SDK ladder
    already retried.
  Both bounds are per step; exhaustion falls to today's failure rails
  (turn error, transient stamp, failed-turn progress). Mid-loop model
  fallback still never advances (zero effect only) — the walk sees a
  turn only after both surfaces are spent.
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

## The claude-code engine — a second turn engine

Ruling 2026-10-27: Anthropic models may ride the **Claude Code
subscription** (OAuth) instead of API credits, via
`@anthropic-ai/claude-agent-sdk` running as a parallel `driveClaude`
engine (src/agent/claude-code/) behind the same turn machinery. Locked
decisions and their why:

- **Not a LanguageModelV4 adapter.** The SDK's contract is a whole
  agent loop (its own tool loop, sessions, permission model), not a
  chat-completions stream; flattening it into a provider adapter would
  fight the CLI at every step. Instead the runtime forks at the step:
  `buildStep` returns a `ClaudeStep` for `kind: "claude-code"` providers
  and `runTurnEngine` routes to `driveClaude`; everything else keeps
  `driveStream`. Both engines emit the identical UIMessageChunk wire,
  journal rows, and model-call/model-call-usage/model-call-failed
  telemetry, so both channel sinks, replay/attach, crash resume, and
  the reviewer stay engine-neutral.
- **One query() per turn, full replay.** No durable SDK sessions: each
  turn feeds the whole assembled view through a deterministic
  serializer (prompt.ts) — same history, same bytes; turn N+1's prompt
  is turn N's plus the new exchange (the prefix-stability invariant
  the API lane gets from append-only ModelMessages, by construction).
  Media rides as Anthropic blocks at its transcript position (the
  view's carries() gate already admitted only image/* and pdf);
  prior-turn reasoning is dropped (thinking blocks cannot replay
  without signatures); old tool results render capped with a stable
  truncation marker. The prompt is machine-assembled, so
  `verbatimPrompts` — no `@path` expansion, no slash-command dispatch.
- **The tool surface is goblin's ToolSet, nothing else.** `settingSources:
  []`, no built-in CLI tools, no CLI permissions; goblin's fenced tools
  register through an in-process SDK MCP server (tools.ts) — handlers
  run in goblin's process, the child only orchestrates model calls.
  `Runtime.fenceTools` wraps every execute, so authority re-checks and
  journal dispatch/result/error rows are inherited unchanged. Id
  namespaces stay separate: the vendor handler receives no tool_use id,
  so the bridge mints its own result queue; the engine pairs stream-frame
  tool_use ids with queued results by (name, exact input) then FIFO,
  emitting goblin's exact outputs on the wire.
- **Auth isolation.** The auth.jsonl record resolves to
  `CLAUDE_CODE_OAUTH_TOKEN`, injected into the child env ONLY — the
  SDK's `env` option replaces the child environment wholesale
  (spike-verified), so no spawned tool inherits goblin secrets and
  goblin's process env never sees the token. `CLAUDE_CONFIG_DIR` pins
  all child state under `$GOBLIN_HOME/state/claude-code/` — nothing
  touches `~/.claude`. The updater and nonessential traffic are off.
- **v1 rulings.** Steered messages defer to the next turn (the CLI's
  loop offers no mid-run injection seam — folding would mean a second
  query; queued steers lead the successor turn as usual). No forced
  toolChoice cuts: the loop detector and watchdog still journal their
  state but cannot cut this engine; there is no `maxTurns` cap either — the
  no-step-budget ruling below applies to this engine too. Rate-limit and
  auth failures fail loud with distinct text, no auto-retry (the
  subscription window resets on its own; switching the conversation to
  an API model is the operator's move). Overflow rides the existing
  recovery (compaction + fresh turn) minus partial-resume — the partial
  continuation seam is an API-lane SDK feature. Compaction summarizes
  through the same engine (text-only, tools off); reviewer, titles,
  and vision stay on AI SDK models (they are goblin's own calls, not
  the operator's conversation).
- **Pinned, not assumed.** The SDK's event shapes are pinned as
  structural types (translate.ts) behind an injectable `ClaudeQuery`
  seam — the fake query (testkit/fake-claude.ts) drives the engine
  suite without the vendor. Model-serving frames (real event streams,
  usage splits, rate-limit/overflow surface) were type-pinned from the
  SDK's declarations and the no-auth spike; the live drift check
  (`GOBLIN_CLAUDE_CODE_LIVE=1`, Phase 4) re-pins them against the real
  subscription. Red drift check means the interface moved: one probe,
  re-pin, fix the adapter.

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

Calibration (`scripts/loop-calibrate.ts`, since replaced by
`scripts/system1-eval.ts`; 2026-10-07: six longest stored
tool turns + six synthetic cases, three runs each, deterministic per
input):

| | progress cases (max) | stuck cases (min) | MCPi flail @16 |
|---|---|---|---|
| `inception/mercury-decide:free` (prod) | 0.085 | 0.963 | 0.963 |
| `typesafe/jev-1.13` (fallback) | 0.22 | 0.97 | 0.54 |

The threshold sits in the gap for both; the MCPi turn (16 searches for an
unannounced project) scores stuck on the prod model — correctly. Small
sample, no real turn over 28 calls: rerun when a long turn lands,
re-calibrate before changing either model. `inception/mercury-decide:free`
has returned 404 since 2026-10-29 and `perplexity/pplx-decider-v1.2` replaced
it on 2026-11-06 (design/system1.md → Model evaluation).

**3. The context landing.** With no budget, an overflow is the one
remaining way a long turn dies without an answer — the in-flight reply
isn't stored until the turn ends, so it isn't compactable. A step whose
reported input nears the catalog window lands tools-off — the turn ends in
prose and a "continue" handoff. Measured headroom: ~700 input tokens per
tool call (the 28-call Safari turn finished at 24k on a 1M window) — the
physical bound on a turn, not a practical one. Ruling 2026-10-25
([compaction](compaction.md) → Timing): in-turn compaction of the partial
is now built as the normal path — a step-boundary pre-emption folds
mid-turn and resumes the turn on the compacted view before the next call
dispatches, and a context landing that issues at the same boundary
retracts in its favor. The landing remains the backstop when compaction
is not wired or the turn's one fold-resume is already spent.

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

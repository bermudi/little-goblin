> Audited 2026-10-23 16:29 local, at repo commit `59d3f7d7` (tracked tree clean; only untracked audit/ notes). Production files are identical at `9d4f861e`, the HEAD this audit closed on — its sole change is app/src/WindowView.test.tsx.

# Hunt 03 — model layer (src/agent/: prompt, compaction, filter-stream, thinking, providers, provider-errors, models-dev, zai-responses, sniff, title, step, cache-contracts, attachments, image, vision, catalog-fetch, codex/)

Date: 2026-10-23. Read-and-report only; no code touched, no live services, no
env-gated tests, no secrets read. Test command from the brief: **247 pass / 0
fail** across the 15 scoped files; `bun run typecheck` (both tsc programs)
clean. SDK shape claims verified against installed `node_modules`
(@ai-sdk/provider v4 `finishReason.unified` incl. `"content-filter"`, nested
`inputTokens.{total,cacheRead,cacheWrite}`; @ai-sdk/openai-compatible and
@ai-sdk/openai both derive `providerOptionsName` as
`name.split(".")[0].trim()`, matching thinking.ts's key derivation;
openai-compatible's audio formatter accepts only wav/mp3/mpeg, matching
providers.ts's pipe gate).

Verdict up front: **no P0/P1 found.** This layer is heavily tested and its
invariants held under adversarial reading; the findings below are one P2 edge
and P3 hygiene/leads. Several initially promising suspicions were refuted with
evidence (listed in §2).

---

## 1. Findings (most severe first)

### P2-1 — codex SSE parser discards a trailing unterminated frame at EOF; a complete answer can die as "ended before a terminal response"

- **Where:** `src/agent/codex/model.ts:156-189` (`sseEvents`) with the
  loop-end guard at `src/agent/codex/model.ts:500-502`.
- **What:** the read loop `if (done) break;` exits with any undelivered bytes
  still in `buf`; nothing flushes the remainder. If the backend's final
  `response.completed` (or `[DONE]`) data line is not followed by a blank
  line before the connection closes, that frame is never parsed,
  `state.sawTerminal` stays false, and `doStream` pushes
  `error: "codex stream ended before a terminal response"` — a turn that had
  a full answer on the wire fails.
- **Rule violated:** design/model.md → "No step budget — loops are caught, not
  capped" → "The invariant stands: **a turn always ends in an answer**, and
  the log explains every early landing" — this early landing is caused by none
  of the four sanctioned bounds, only by parser behavior.
- **Inconsistency evidence:** the sibling SSE translator the same authors
  wrote flushes exactly this case — `src/agent/zai-responses.ts:103-107`:
  `flush(controller) { buf += decoder.decode(); if (buf.length > 0)
  controller.enqueue(encode(rewriteEvent(buf))); }`. codex's parser handles
  multi-data-line joins "per the SSE spec" (model.ts:174-179) but omits the
  EOF flush its sibling has.
- **Caveat (honest):** per the SSE spec, dispatch happens at a blank line, so
  a spec-compliant server always terminates events and this only bites when a
  proxy trims the final separator or the backend closes abruptly. Unverified
  against the real chatgpt.com backend (no live calls in this hunt).
- **Test sketch:** feed `doStream` (via the existing fake-fetch harness in
  `codex/model.test.ts`) a body whose last event is
  `data: {"type":"response.completed", …}` **without** a trailing `\n\n`,
  then EOF. Today: error part, turn fails. Expected: finish part mapped.

### P3-1 — codex backend responses are not schema-validated at the boundary; `String(item.arguments ?? "{}")` silently corrupts a non-string arguments value

- **Where:** `src/agent/codex/model.ts:183` (`JSON.parse(data) as
  Record<string, unknown>`), `:203-204` (`event.type as string`,
  `event.item as Record<…>`), `:237` (`input: String(item.arguments ?? "{}")`),
  `:272-275` (usage casts), `:378` (`(options.providerOptions?.codex ?? {})
  as CodexProviderOptions`).
- **Rule violated:** AGENTS.md → Guardrails: "Validate external input with
  zod at boundaries". Every sibling adapter in this hunt honors it —
  `models-dev.ts` (wire + disk), `catalog-fetch.ts` consumers, `image.ts`
  (`imagesResponse`), `codex/auth.ts` (`authFileSchema`,
  `refreshResponseSchema`). The codex SSE stream is equally external and is
  instead defensively coerced. Fail-loud corollary: a gateway that ever sends
  `function_call.arguments` as a parsed object (not a JSON string) yields
  `input: "[object Object]"` — the tool call then fails input parsing with a
  misleading error instead of a named shape error.
- **Reachability today:** low — the pinned backend sends string arguments;
  every other field is coerced via `String()`/`num()` and degrades rather
  than crashes. Filed as invariant hygiene, not a live break.
- **Test sketch:** `mapEvent` on `{"type":"response.output_item.done","item":
  {"type":"function_call","call_id":"c1","name":"t","arguments":{"a":1}}}`
  → today produces `input:"[object Object]"`; a zod schema would reject with
  a named error.

### P3-2 — catalog fetch reads the response body without any size cap

- **Where:** `src/agent/catalog-fetch.ts:82-84` —
  `fetch(…); if (!res.ok) throw …; spec.parseWire(await res.json())`.
- **What:** `res.json()` buffers the entire body unbounded. `image.ts` caps
  its provider responses (`RESPONSE_CAP = 64 MiB`, `readBytesCapped`) for
  exactly the "misbehaving gateway" reason; the two catalogs (models.dev
  ~1 MB legitimately, openrouter) have no equivalent. A broken/hijacked
  endpoint serving a multi-GB body turns into unbounded memory use in the
  turn path (`buildStep` awaits `inputModalities`/`contextLimit` →
  `ensure()`).
- **Rule violated:** AGENTS.md → Guardrails, fail loud / robustness at
  external boundaries (the codebase's own precedent is the image cap).
- **Triggering input:** catalog endpoint returns `200` with an enormous body.

### P3-3 — `glmVersion` misprofiles an unversioned `glm-*` id as the ≤4.6 toggle model

- **Where:** `src/agent/thinking.ts:400-403` — `/^glm-(\d+)\.(\d+)/` requires
  a minor version; no match → `{major: 0, minor: 0}` → `glmProfile` falls to
  the `levels: ["low"], off: "disable", knob: "toggle"` branch
  (`thinking.ts:222`).
- **What:** a bare `glm-5` / `glm-6` id on the general paas path would be
  offered the one-rung toggle ladder and sent `{ thinking: { type: "enabled" } }`
  with no effort — while the family's own trend (design/model.md → Thinking:
  "5.3+ forced thinking, effort low|high|max") says a newer unversioned id is
  almost certainly forced-thinking. Misleading ladder + wrong wire form
  rather than the "unknown route" honesty the ruling demands.
- **Rule tension:** design/model.md → Thinking: "An unknown route … keeps the
  whole vocabulary and sends no reasoning knob at all for `off` … fail loud,
  never fake knowledge" — an unparsed version silently *narrows* the ladder
  instead.
- **Lead (unverified):** every glm id in the wild and in the cached catalogs
  carries a minor version; I could not find an unversioned id in any local
  source. Filed as lead, not live bug.

### P3-4 — 1min "tools demand none" rule uses exact ids for gpt-6 sol/luna but a prefix regex for gpt-5.6*

- **Where:** `src/agent/thinking.ts:164-169` —
  `/^gpt-5\.6/.test(modelId) || modelId === "gpt-6-sol" || modelId ===
  "gpt-6-luna"`.
- **What:** any variant/suffixed id (`gpt-6-sol-2026-…`, a hypothetical
  `gpt-6-sol-mini`) misses the rule, falls into the `/^gpt-[56]/` reasoning
  family (`thinking.ts:177`), and every tools-carrying chat call sends an
  effort rung instead of `"none"` — a 400 per the relay's docs (design/
  model.md → 1min.AI relay: "GPT-5.6* and GPT-6 Sol/Luna … demand `none`
  whenever a request carries tools"). The gpt-5.6 family already uses the
  prefix form, so the asymmetry is internal, not doc-driven.
- **Lead (unverified):** whether the relay lists versioned variants is
  unverifiable here (1min has no models.dev entry and live calls are out of
  bounds). If the relay only ever lists the bare names, this is dormant.

### P3-5 — title cap counts code points; Telegram's 128-char topic-name limit may count UTF-16 units

- **Where:** `src/agent/title.ts:62` — `[...title].slice(0, MAX_TITLE_CHARS)
  .join("")` truncates to 128 Unicode code points.
- **What:** a title of ≤128 code points containing astral-plane characters
  (emoji ≈ 2 UTF-16 units each) can exceed 128 UTF-16 code units; if
  Telegram counts units (it does for message lengths), `editForumTopic`
  rejects and the one-shot rename is lost (fails loud downstream, placeholder
  topic name stays).
- **Lead (unverified):** the Bot API's counting unit for forum topic names is
  not documented in anything local; title models rarely produce 64+ emoji, so
  reachability is thin. Sketched test: sanitize a 100-emoji string, assert
  UTF-16 length ≤ 128.

### P3-6 — codex auth merge spread can write garbage keys from a corrupt `tokens` field

- **Where:** `src/agent/codex/auth.ts:177` — `tokens: { ...(existing.tokens
  as object | undefined), ...tokens }`. `existing` comes from a raw
  `JSON.parse` (`:154`) with no shape check; if the incumbent file's
  `tokens` is a string/number (hand-mangled file), spreading it emits
  char-index keys (`{0:"a",1:"b",…}`) into the written auth file alongside
  the fresh fields. Not secret-leaking (values already in the file), but the
  "fail loud" posture would be a parse error instead. Same family as P3-1:
  an unvalidated external file read one step before a validated one.

---

## 2. What I checked and found clean (later passes can skip)

Cache stability (DESIGN.md → Cache stability; model.md → Content):

- **System prompt carries no per-turn variability.** `buildSystemPrompt`
  (prompt.ts) has no clock/counter (test-pinned); `systemPromptFor` freezes
  per conversation via the store snapshot; `buildStep` calls it once per turn
  and the runtime passes the frozen `step` through the whole SDK loop
  (runtime.ts:1126, turn/stream.ts:313-439) — no per-step config re-read. All
  four sanctioned snapshot clears verified: compaction (runtime.ts:583),
  persona switch (tg/guest.ts:376), DM roll (new conversation id ⇒ new
  snapshot), spin-off/new conversation.
- **Attachment representation is the sanctioned pure function.**
  `materializeAttachments` (attachments.ts) judges each part independently —
  no whole-turn budget, no newest-first eviction (tests pin both); only
  planned-inline items touch disk; only disk failure/over-cap degrades with
  a warn; non-speech audio never inlines; transcripts ride the fallback.
  Runtime calls it once per model view and per steer conversion with the
  turn-frozen gates (turn/view.ts:158, 258; capability gates frozen from
  buildStep's step at runtime.ts:1148-1155).
- **Prefix bytes are append-only in the turn loop.** Steers/warnings/nudges
  are tail-appended in `prepareStep` (turn/stream.ts:352-437); filter retry
  resends the identical request (onError ladder, `filterRetryUsed`).
- **Compaction is an explicit logged boundary.** "compaction window" /
  "compaction summarizing" / "history compacted" lines; `doCompact` clears
  the prompt snapshot only on `kind: "compacted"` (runtime.ts:580-587).
- **Sanctioned-rewrite enumeration:** model switch ⇒ admission-time
  `conv.model` change only; catalog-refresh modality change ⇒ pure-function
  recompute on the next build (no extra machinery to misuse).

Compaction (model.md → Compaction):

- `chooseBoundary` traced adversarially (anchored bursts, tiny/huge budgets,
  previous-boundary stops, minSpan floor gating the delta, spanStart
  fallback): cuts are exchange-complete, interleaved bursts stay atomic,
  nothing below the previous boundary refolds, and the cut key
  `(anchorSeq ?? seq) > boundarySeq` matches `modelEntries` (conversation.ts:
  308-313). "Nothing worth compacting" noop only fires per its guards.
- `runCompaction`: delta-only spans with the previous summary carried; chunk
  allowance math with floors; oversized first event truncated not stalled;
  per-call timeout race (`AbortSignal.any` + explicit race) so a wedged
  summarizer settles; `signal.throwIfAborted()` **and** `assertAuthority`
  before every chunk and again after the last call, before the pointer
  commits; fence/abort mid-summary provably writes no pointer (tests
  "cannot publish a pointer" ×2). The fenced-mid-lookup `/compact` ruling is
  satisfied by the caller: `doCompact` checks authority immediately after the
  `contextWindow` await (runtime.ts:544-552) and the path from there to
  `chooseBoundary`'s decision is fully synchronous — no await window exists
  for a fence to land in. Compaction metadata lookup resolves no auth and
  builds no prompt (step.ts:93-96 per ruling 2026-10-19).

Provider-filter recovery (model.md → Provider-filter recovery):

- `filterErrorStream` (filter-stream.ts): the buffering wrapper keeps pulling
  until it can emit or finish (the 2026-10-05 strand regression is covered);
  tools buffer until a clean finish and are dropped on a filter; content
  filters are detected from both thrown `doStream` errors and in-stream
  `error` parts (via the warning-text walk) and `finish` parts
  (`unified === "content-filter"` — shape verified in @ai-sdk/provider and
  the openai/openai-compatible mappers); non-filter errors flush buffered
  tools then propagate (`controller.error`), never swallowed; cancel
  forwards. Ordering: text-before-tools preserved through the buffer+flush.
- `provider-errors.ts`: union walk (message/statusCode/responseBody/data/
  cause/lastError/error/response/errors, depth 4, cycle set); overflow vs
  rate-limit vs reasoning-required precedence is mirrored between
  `isContextOverflow` and `isTransientTurnFailure` exactly as the comments
  claim; `REASONING_REQUIRED` guard prevents compact-behind-a-400 loops;
  the operator-pasted FILTER_WARNING is matched verbatim-folding; refusal
  text never inspected.
- 1min `maxRetries: 0` verified on **every** chat call site: turn steps
  (step.ts:57), compaction summaries (step.ts:109), titles (title.ts:84),
  vision (vision.ts:217), reviewer (reviewer.ts:226,1139 — outside scope,
  pointer only), note-rewrite hardcodes 0.

Thinking (model.md → Thinking):

- Profiles match the ruling's tables: glm 5.3+/coding-endpoint
  `low|high|max` forced (alias rule incl. the `/api/v1` responses door),
  5.2 `high|max`+disable, ≤4.6 toggle; openrouter unknown route keeps the
  whole vocabulary with `off` = route default and sends **no** disable;
  mandatory models clamp stored `off` to the weakest rung; clamp direction
  at-or-above everywhere; the ladder offered IS the profile.
- **Suspicion refuted with evidence:** I suspected `off: r.mandatory ===
  true ? "floor" : "disable"` (thinking.ts:115) offers a disable the route
  can't back when `supported_efforts` lacks `"none"` (ruling: "`none` in
  supported_efforts is the disable"). Against the real cached catalog
  (`$GOBLIN_HOME/state/openrouter-models.json`, public data, read-only):
  **0 of 112** non-mandatory effort-routes lack `"none"`; the 91 routes
  without it are all `supported_efforts: null` toggle models, which correctly
  get `{ enabled: false, exclude: true }`. The published effort universe is
  exactly goblin's vocabulary (`minimal…max, none`). The code comment's
  empirical claim holds for the current catalog (contents drift — recheck
  with the 30-day cache-contract pass).
- providerOptions key derivation (`provider.split(".")[0].trim()`) matches
  the installed @ai-sdk/openai-compatible and @ai-sdk/openai
  `providerOptionsName` implementations — dotted provider names ("z.ai") key
  correctly; the `{ thinking: … }` GLM object rides the SDK's raw
  providerOptions spread as intended.

Streaming/usage observability (AGENTS.md → Guardrails; DESIGN.md):

- `observedModel` (providers.ts): every call logs "model call" (request/
  head/settings hashes, prefix relation) and "model call usage" (nested v4
  cached split) or a staged failure ("invoke"/"read"/"provider-error"/
  "cancel"/"no-finish"); failed observation writes fail the stream loudly
  (tested); no-finish closes are not success receipts; error fields are
  redaction-safe (names restricted to a safe set, status clamped to 100-599).
  All call sites (step, compaction, title, vision, reviewer) route through
  it. Prompt/message hashing is deterministic per construction.

Other scoped files:

- `models-dev.ts`: wire and disk zod-validated for both catalogs; unknown ⇒
  conservative (text-only / unknown), never fatal; shared-flight fetch with
  backoff; pre-reasoning cache shape refused whole; scan-fallback lookup
  identical across all four read functions; cold-read kicks fetch except on
  the deliberately kick-free HTTP paths.
- `zai-responses.ts`: translation scoped to api.z.ai hosts and
  text/event-stream responses; reasoning_text → reasoning_summary mapping
  probe-pinned and tested through the real SDK parser; parse failures pass
  through verbatim; `[DONE]` handled; CRLF handled.
- `sniff.ts`: PNG/JPEG/GIF/BMP/WEBP magic + dimension offsets re-derived and
  correct; JPEG segment walk bounded and SOF dims guarded by the loop
  condition; truncated heads name the type without dims.
- `attachments.ts` path safety: `isStoredAttachmentPath` enforced at the app
  intake boundary (http/app-chat.ts:62-68) before refs can ever reach
  `readFile`; schema validated again at the disk boundary with malformed ⇒
  placeholder fallback (never parses as speech, matching model.md → History).
- `image.ts`: zod on the response, b64-only policy, magic-byte sniff before
  naming files, timeout+turn-signal race, cost log line, auth never logged.
- `vision.ts`: threads keyed per conversation+path+size+mtime, model switch
  clears, auto-mode registration requires catalog AND pipe blindness (1min
  keeps the vision tool per the relay ruling), thinking pinned off, 1min
  retry rule applied.
- `title.ts`: input capped, usage logged, decoration stripped; thinking "off"
  rides the standard mapping (never a disable a model can't back).
- `codex/auth.ts`: fresh read per call; single-flight refresh (a /stop never
  reaches the shared flight — documented); lost-race adoption on 400;
  rotated refresh token written back durably with 0o600 (the model.md →
  Provider facts requirement); zod on both file and refresh response.
- `codex/model.ts` (besides P2-1/P3-1): prompt conversion correct (text/
  image/pdf in user; function_call/function_call_output pairing; assistant
  reasoning dropped per no-echo design; `store: false`); finish mapping
  (tool-calls > incomplete-length > stop) and nested v4 usage verified;
  doGenerate reuses doStream and cancels the reader before rethrowing;
  warnings computed for unsupported settings/tools.
- Guardrails: no `console.log`, no `any`/`as any` in any scoped file;
  non-null `conv.model!` uses are admission-guaranteed (runtime) and fail
  loud if ever violated.

## 3. What I couldn't verify / leads without a written source

- **Live wire behavior of the codex backend** (P2-1's blank-line premise) —
  no live calls allowed; the failure is argued from the sibling module's
  flush and stays labeled edge.
- **1min's actual model list** (P3-4) — no models.dev entry, no local cache;
  the exact-id rule is doc-faithful but unverifiable against variants.
- **Telegram's topic-name length unit** (P3-5) — not documented locally.
- **The openrouter catalog claim in thinking.ts:126-127** ("every
  non-mandatory model in the catalog lists ['none']") — true **today** against
  the cached catalog (see §2); the cache is a snapshot and the claim has no
  enforcement — if OpenRouter ever lists a non-mandatory effort-route without
  `"none"`, goblin will offer and send a disable the route didn't publish.
  Worth a line in the 30-day cache-contract re-check, not a code change.
- **SDK-level retry interaction with filter errors arriving as 5xx** — if a
  provider misclassifies a content filter as a 500, the SDK's own
  maxRetries (default 2, non-1min) silently re-bills before goblin's
  one-per-turn ladder ever sees it. I found no written ruling covering this
  overlap (model.md → Provider-filter recovery covers goblin's retry only);
  providers in practice send filters as 400/finish-reason, so this is a
  suspected-but-unwritten edge, not a cited violation.
- `prompt.ts` "byte-identical to the pre-projects builder" for unbound
  conversations — asserted by comment and test; no historical builder
  available to diff against.

## 4. Simplifications & code smells (operator-requested section)

- **Dead request weight:** `src/agent/codex/model.ts:385` —
  `include: ["reasoning.encrypted_content"]` asks the backend to inline
  encrypted reasoning into every response, but nothing in the file reads or
  echoes it (`rg encrypted` finds only the include and the comment at :66-67
  explaining why echo is *not* persisted; `mapEvent` has no case for it).
  Pure payload bloat on every codex call — drop it or wire it, don't carry
  it.
- **Self-admitted dead branch:** `src/agent/prompt.ts:148-152` — the
  `dropped <= 0` arm carries its own "Unreachable today" comment with the
  proof. Delete.
- **Misleading bound constant:** `src/agent/prompt.ts:61,81` —
  `MAX_PROMPT_FILE_BYTES` is derived from the 20k cap but also bounds reads
  of the 4k-capped USER.md (reads up to ~60 kB to slice back to 4k). The
  comment's "always detected within this bound" argument only holds per-cap;
  `3 * (cap + 1)` per call would be both honest and 15x cheaper.
- **Duplicated clamp logic:** `src/agent/thinking.ts:228-233` — `glmEffort`
  is `clampToLevels` with a different empty-set fallback; both are "nearest
  rung at-or-above". One function with a fallback parameter would remove a
  drift risk the file's own header calls out (GLM's collapse direction must
  stay the same everywhere).
- **Global-fetch binding through an injectable seam:**
  `src/agent/zai-responses.ts:137` — `Object.assign(wrapped, { preconnect:
  fetch.preconnect })` binds the *global* fetch's preconnect even when a
  custom `baseFetch` was injected; `(baseFetch as …).preconnect ??
  fetch.preconnect` would honor the seam.
- **Hand-mirrored usage type + cast:** `src/agent/vision.ts:117-127,231` —
  `VisionUsage` re-declares the SDK's usage shape only to `as`-cast
  `{ text, usage }` into it; reusing the SDK's `LanguageModelUsage` type
  removes the duplicate and the cast.
- **Lookup rule written four times:** `src/agent/models-dev.ts` —
  direct-key-then-scan-then-default appears in `inputModalities` (:66-76),
  `inputModalitiesCached` (:81-94), and twice via `limitIn`/`contextLimit`
  (:99-133); one shared `lookup<T>(cat, provider, modelId, pick)` collapses
  them and keeps the "same lookup rule" comments true by construction.
- **Duplicated span computation:** `src/agent/compaction.ts:85-88` and
  `:231` — the identical `previousBoundary` → spanStart expression
  (including the unfound-fallback) is derived twice; `chooseBoundary`
  returning the span start alongside the boundary would keep them from
  drifting (a drift here would re-fold compacted history into a summary).

---

### Severity counts

P0: 0 · P1: 0 · P2: 1 (P2-1) · P3: 6 (P3-1…P3-6) · plus 8 simplification notes.

Test command: `bun test <scoped files>` — 247 pass / 0 fail; `bun run
typecheck` clean.

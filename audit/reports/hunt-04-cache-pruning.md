> Audited 2026-10-23 16:23 local, at repo commit `59d3f7d7` (tracked tree clean; only untracked audit/ notes). Production files are identical at `9d4f861e`, the HEAD this audit closed on — its sole change is app/src/WindowView.test.tsx.

# Hunt 04 — cache pruning / observation / window capture

Scope: `src/cache-observation.ts`, `src/cache-pruning.ts`,
`src/cache-pruning-policy.ts`, `src/pruning-marker.ts`,
`src/window-capture.ts` + colocated tests.
Governing spec: DESIGN.md → Cache stability (plus design/model.md →
Cache contracts, design/tools.md → recovery, AGENTS.md → Guardrails).
Mode: read-and-report. Test command run from repo root:

```
bun test src/cache-observation.test.ts src/cache-pruning.test.ts \
  src/pruning-marker.test.ts src/window-capture.test.ts
# 55 pass, 0 fail, 180 expect() calls
bun run typecheck   # both tsc programs clean
```

## 1. Findings (most severe first)

**No P0 and no P1 findings.** The core rulings hold under every probe I
could construct from the code. One P2 (observability edge on the
suspension notice path) and several P3s below.

### P2-1 — a *new* contradiction under a *revised* profile is silent for the process lifetime

- `src/cache-pruning.ts:65-76` (notice/dedupe), `:111`, `:176`;
  `src/index.ts:404-406`.
- Rule in tension: DESIGN.md → Cache stability — "a contradiction
  suspends new batches — never committed rows (an unchanged-prefix
  zero-cache-read call inside the window, **an expired profile**, or a
  documented expiry the contract registry can't support)". All three
  are suspension causes of equal standing, and the module's own dedupe
  comment (cache-pruning.ts:62-64) states the dedupe exists because
  "repeats are noise" — i.e., only repeats should be suppressed.
- What happens: the dedupe key is `` `${kind}:${convId}:${routeKey}` ``
  (line 72). For expiry the code deliberately makes the key
  renewal-sensitive — `` notice(`expired:${profile.validUntil}`, …) ``
  at line 116-119, with the comment "a renewed profile that expires
  again is a new finding, not a repeat." For `contradicted` no such
  sensitivity exists: kind is the constant string `"contradicted"`
  (lines 111, 176). Sequence: profile A is contradicted (warn logged,
  suspension row written for A's hash) → operator revises the profile
  (any byte change → new profileHash, the documented lift, test
  `a contradiction stays suspended past a later cache hit`) → later a
  *fresh* contradiction develops under profile B → the next drain pass
  writes B's suspension row and returns `{pruned: 0, reason:
  "drift-contradiction"}` — but `notice()` suppresses the warn because
  `("contradicted", conv, route)` was already noticed in this process.
- Why it matters here specifically: `index.ts:404-406` discards
  `pruneConversation`'s return value (`pruneBetweenTurns: (convId) => {
  cachePruning.pruneConversation(convId); }`), and nothing else in the
  tree reads `cache_pruning_suspensions` or the reason strings
  (verified by grep — only the scoped modules reference them). The
  warn line is therefore the *only* operator-visible signal that
  pruning is suspended, and the second, distinct finding produces none
  until a restart.
- Behavior is still safe (the gate does suspend; no commit lands), so
  this is a broken edge of the notice/error path, not a gate defect.
- Catching test: extend `cache-pruning.test.ts` "a contradiction stays
  suspended past a later cache hit" — after the lifted profile prunes,
  record a fresh zero-read same-prefix receipt inside the window,
  advance past idle, prune again, and assert a *second*
  "cache policy contradicted" line in the log file (it currently
  won't appear). Fix shape (not applied): key the kind with the
  profileHash slice, mirroring `expired:${validUntil}`.

### P3 findings (invariant hygiene)

1. **`cacheSourceReportSchema` is dead and its source-id enum has
   drifted from the registry.** `src/cache-pruning-policy.ts:9,50-60`:
   `sourceIdSchema = z.enum(["zai","openrouter","anthropic","openai",
   "logfare"])` while `src/agent/cache-contracts.ts:22-37`
   (`cacheContractSources`) also defines `onemin`. No production or
   test code imports `cacheSourceReportSchema` (grep: zero usages
   outside its definition). If it is ever wired to a doctor re-check
   report it will reject any report covering the `onemin` source. AGENTS
   MD → Guardrails "fail loud" is not violated (nothing parses), but a
   schema that cannot represent a known contract source is a trap.
2. **`CachePruningProfile.model` is never consulted.**
   `src/cache-pruning-policy.ts:13`; the gate at `src/cache-pruning.ts:
   97-100` selects purely on `routeKey + settingsHash`, and `routeKey`
   already embeds `modelRef` (providers.ts:119-145 — `cacheRouteFor`
   includes `modelRef` in the hashed object). A profile whose `model`
   string disagrees with its own `routeKey` applies silently. The field
   is operator-facing metadata only; nothing documents that, and
   nothing enforces consistency.
3. **`CacheCompletedReceipt.settingsHash` is an unused echo.**
   `src/cache-observation.ts:13,200,213` — both `lastCompleted` and
   `completedReceipts` return the `settings_hash` the caller filtered
   by; the only consumer (`cache-pruning.ts:142-181`) never reads it
   (it uses `finishedMs`, `inputTokens`, `idleMs`, `cacheRead`,
   `prefixRelation`). Dead payload on the interface.
4. **`read()` zod failures lose the conversation context that decode
   failures carry.** `src/window-capture.ts:201-213` — a corrupt gzip
   throws `stored context window for <id> failed to decode: …`
   (line 208-210) but a decodeable payload of the wrong shape throws a
   bare ZodError from `captureSchema.parse(parsed)` (line 212) with no
   conversation id. Fail-loud is satisfied; diagnosis asymmetry is the
   smell. AGENTS.md → Guardrails "Every failure surfaces with enough
   context to debug it."

### Leads (unverified suspicions — labeled as such, not counted)

- **`stubBinary` depth guard defeats its own stub.**
  `src/window-capture.ts:71-73`: at `depth > 24` the raw value is
  returned as-is, so a binary leaf nested deeper than 24 levels would
  reach `JSON.stringify` as the "numeric-dictionary monster" the
  comment at lines 59-61 warns against. Behavior is certain from the
  code; *reachability* is not — media parts sit at depth ~3-4 and tool
  outputs are strings, so I could not construct a real prompt that
  trips it. Would need a deep dynamic-tool output object containing a
  typed array; unverified that the SDK can produce one.
- **`serializeToolDefs` `.then` access on a possibly-undefined
  `jsonSchema`.** `src/window-capture.ts:49-53`: if
  `asSchema(tool.inputSchema).jsonSchema` were ever `undefined`
  (rather than a thenable), `typeof (js as {then?}).then` throws
  TypeError. The identical idiom exists in `turn/itemize.ts:142-145`
  ("the same floor itemize counts"), and itemize runs on every
  production step without incident — so this is almost certainly fine,
  but I could not verify the SDK's `asSchema` contract to prove
  `jsonSchema` is never undefined. Not a finding without that.
- **Empty previous prompt_hashes makes "append" vacuous.**
  `src/cache-observation.ts:250-258`: a completed previous call with
  `prompt_hashes: []` and a non-empty current prompt yields relation
  `append` (shared = 0 = prevLen). A zero-cache-read receipt of that
  shape would count as an "unchanged-prefix zero-cache-read call" for
  the drift check despite no prefix ever being cacheable. I found no
  caller that can complete a zero-message model call (streamText
  always sends ≥ 1 message; title/review/vision prompts are
  non-empty), so I believe it unreachable — labeled lead, not a
  finding.

## 2. Checked and clean (later passes can skip)

- **`events` rows are never mutated from these modules (the P0
  probe).** Every SQL write in the scoped files targets companion
  tables only: `model_cache_calls` (insert/update own rows),
  `cache_pruning_suspensions`, `context_windows`,
  `context_window_state`; projections go through
  `store.applyEventProjections` → `event_projections` (INSERT OR
  IGNORE, PK `(conversation_id, seq, tool_call_id)`,
  conversation.ts:770-780, 1049-1050). The model-facing overlay
  (`modelEntries`, conversation.ts:1768-1808) mutates freshly parsed
  objects only — parseEvent re-parses per call, so history/context/
  search readers always serve originals (pinned by
  cache-pruning.test.ts:206-229 asserting `historyDetail`, `history`,
  and `eventContext` still return `BIG` after commit).
- **Marker replay is byte-identical across restarts.** The replacement
  string is computed once at commit (`pruningReplacement`,
  deterministic: code-point head/tail slices, fixed JSON key order in
  `pruningRecoveryAddress`, `fenceUntrusted` escaping is pure) and
  stored verbatim; `eventProjections`/`modelEntries` replay stored
  bytes, never recompute. The prune loop re-derives `projected` from
  the store each pass (cache-pruning.ts:199-201), so an already
  projected event can't be re-projected even under a different
  profile. Pinned by the close/reopen test (cache-pruning.test.ts:
  231-247) and the idempotency test (:249-257). The fork retarget
  (pruning-marker.ts:26-37) is exact serialized-object `replaceAll`;
  the false-hit analysis in its header comment is sound (a false hit
  needs the original output to quote this call's own seq+toolCallId
  address verbatim) and test-pinned both ways.
- **Batch commits never land mid-turn, on an expired, or on a
  contradicted profile.** The only production call site is
  `runtime.ts:797` — `drain()` under `lane.running`, immediately
  before `runTurn`, synchronous, errors caught and logged (turn
  proceeds). Inside `pruneConversation` the order is: persisted
  suspension (:104-115) → expiry (:116-121) → documented-expiry
  registry support (:122-141) → completed-call existence, fail closed
  (:142-146) → drift scan of every receipt since `reviewedAt`
  (:155-181) → idle gate (:182) → token gate (:183) → single
  synchronous transactional commit (:258). No awaits between gates and
  commit. (The boundary trigger itself is hunt 2's; this pass only
  confirmed the call site shape.)
- **Suspension never unwinds committed rows.** `suspendPruning` is
  INSERT OR IGNORE only; nothing in the scoped modules (or anywhere —
  grepped) deletes from `event_projections` or `model_cache_calls`.
  Suspension is keyed by full-profile hash
  (`sha256(stableStringify(profile))`), so only a changed profile
  lifts it — matching the docstring at cache-observation.ts:62-64 and
  the "stays suspended past a later cache hit" test (:454-488).
- **Zero-cache-read is never automatic proof of provider bug or
  warmth.** The contradiction requires the conjunction
  `(same|append) ∧ idleMs ≠ null ∧ idleMs < idleAfterMs ∧ cacheRead
  === 0` (cache-pruning.ts:161-167); null cacheRead (provider didn't
  report the split) is never a contradiction — and
  cache-observation.test.ts:89-107 pins null-vs-zero preservation at
  the write boundary. Prefix relations are recorded as structural
  facts; both `same` and `append` additionally require unchanged head
  AND settings (cache-observation.ts:248-261), so a head or settings
  move with identical prompts reads `rewrite` (tests :122-151).
- **Receipts are zod-parsed at every boundary.** `prevSchema`
  (cache-observation.ts:80-86), `lastCompletedSchema` (:88-95),
  `hashesSchema.parse(JSON.parse(prompt_hashes))` (:245), the
  suspension row (:229), `callRowSchema` (:328-342), and the window
  row/payload (:106-104, 202-212 in window-capture.ts). Corrupt input
  propagates loud (JSON.parse/gunzip throw with context where
  applicable).
- **Window capture stores the exact outbound prompt, not a
  reconstruction.** Staged in `prepareStep` (`notePrompt` captures
  stepMessages, or the outbound array when warnings/nudges/steers are
  injected — turn/stream.ts:308-359), promoted only in `onStepEnd`
  after dispatch, `stepCount === 0 ⇒ null` (stream.ts:739-752),
  serialized exactly once in `record` (window-capture.ts:178-200).
  Media stubbing to byte counts is disclosed in the module header
  (lines 8-11) and test-pinned (:62-95). The recall-version fence is
  transactionally consistent (delete + bump in one transaction,
  :134-146) and stale records are skipped with a log line, not
  silently. `PromptSegments` keys match `captureSchema.segments`
  exactly (itemize.ts:11-27 vs window-capture.ts:93-103).
- **The gate hashes the same surface the receipts hash.** The prune
  gate uses `captureConversationSettings` (the same function admission
  uses, conversation.ts:147-159) and `turnCallSettings`' normalized
  shape; cache-pruning.test.ts:490-553 drives a real `streamText`
  through `observedModel` and asserts the receipt's settings hash
  byte-matches the profile's — including the omitted-toolChoice →
  `{type:"auto"}` normalization. Main turn calls pass `purpose: null`
  (agent/step.ts:74-78 passes no purpose), matching the policy
  surface's `purpose IS NULL` filters.
- **Purpose partitioning holds.** qPrev/qLastCompleted/qCompletedAll
  all partition on purpose; compaction/title/review/vision/note-rewrite
  calls are labeled and never anchor the main lineage
  (cache-observation.test.ts:211-230). Failed calls never anchor idle
  gaps (:153-166). Settle-once guards first-terminal-wins (:200-208).
- **Documented-expiry gate matches design/model.md → Cache
  contracts.** Requires registry `lifetime === "rolling-expiry"`, a
  non-null `idleExpiryMs`, `idleAfterMs >= idleExpiryMs` (equality
  allowed — the bound is "expires after 5 minutes"), and a fresh
  manual review (`cacheContractFresh`, 30-day window). zai's
  unpublished contract correctly refuses documented-expiry profiles;
  openrouter/anthropic accepts at the 5-minute bound. Tests pin all
  four directions (cache-pruning.test.ts:384-452).
- **Cutoff and compaction-boundary logic mirror `modelEntries`.**
  `historyDetail` ordering (anchorSeq ?? seq, seq) is the same array
  the cutoff scans; the boundary skip `(anchorSeq ?? seq) <= boundary`
  (cache-pruning.ts:213) matches modelEntries' filter exactly
  (conversation.ts:1774). Fewer-than-N user events ⇒ cutoff 0 ⇒
  nothing pruned (fail closed). Non-shrinking replacements are skipped
  (:239-242), pinned by the 450-char test (:595-617).
- **Cache-call evidence retention.** No DELETE against
  `model_cache_calls` anywhere in the tree; `listCalls`' LIMIT 200 is
  a read-side view bound, and `invalidateWindowCaptures`' DELETE
  touches only `context_windows` (the sanctioned memory-forget path,
  not cache-call evidence). DESIGN.md → Cache stability: "Cache-call
  evidence has no automatic age-based deletion or prompt-hash
  stripping" — holds.

## 3. Couldn't verify / no written source found

- **Runtime drain/turn-boundary ownership** (whether `drain()` can
  ever call `pruneBetweenTurns` while a turn is logically live, e.g.
  crash-resume) is hunt 2's scope; I read the call site
  (runtime.ts:779-818) and it looks correct (`lane.running` guard,
  pre-`runTurn`, sync), but I did not audit the full lane state
  machine.
- **`asSchema(...).jsonSchema` can never be undefined** — AI SDK
  internals; I could not prove it from the repo. Both call sites
  (window-capture.ts:49-53, itemize.ts:142-145) share the idiom (see
  lead above).
- **Reachability of the depth-24 stub passthrough and the
  empty-prompt-hashes `append`** — leads above; no constructing caller
  found, but absence of a caller in this tree is not proof the SDK
  can't produce the input.
- **`z.iso.datetime()` accepted grammar** (offsets, precision) for
  `reviewedAt`/`validUntil` — config parsing of the block is hunt 19;
  the policy semantics here only `Date.parse` the stored strings, and
  `Date.parse` is lenient where zod may be strict (or vice versa). I
  did not chase the divergence; it is inert within these modules
  because the strings come from the already-parsed config object.
- **Out-of-scope pointer (for hunt 2/3, not chased):**
  `turn/stream.ts:361-364` — when steers were claimed but authority
  was lost, `prepareStep` returns undefined without calling
  `notePrompt`, leaving `stagedWindow` at the previous step's prompt
  (or null on step 1); a subsequent `onStepEnd` would promote a stale
  stage for that step. Window capture is affected only as a stale or
  missing record, never a reconstruction; the file is outside this
  hunt's scope.
- **Out-of-scope pointer:** `index.ts:404-406` discards the prune
  result — relevant only in combination with P2-1 above.

## 4. Simplifications & code smells (P3-level, evidence-backed)

1. **Dead export with a drifted enum:** `cacheSourceReportSchema` +
   `sourceIdSchema` (cache-pruning-policy.ts:8-9, 50-60) — zero
   importers anywhere (rg over src/, scripts/, tests), and the enum
   omits `onemin`, which `cacheContractSources`
   (agent/cache-contracts.ts:22-37) defines. Delete it, or sync the
   enum and wire it to the doctor re-check it presumably anticipates —
   as it stands it is both dead and wrong.
2. **`CachePruningProfile.model` is write-only metadata** (see P3-2):
  the gate never reads it; `routeKey` already encodes the model. Either
  document it as operator-facing or validate it against the route it
  pins. Most valuable simplification of this pass: removing or
  validating the field eliminates a silent inconsistency trap in an
  operator-authored bootstrap block.
3. **`CacheCompletedReceipt.settingsHash` unused echo** (see P3-3):
  drop the field from the receipt interface and both query
  projections; callers filter by it, they don't need it back.
4. **Asymmetric error context in `window-capture.read()`** (see P3-4):
  wrap the `captureSchema.parse` failure the same way the decode
  failure is wrapped, with the conversation id in scope.
5. **Minor:** `lastCompletedSchema` and the receipts mapping in
  cache-observation.ts:190-215 duplicate the same row→receipt mapping
  twice five lines apart — one mapper would serve both queries.

## Digest

- P0: 0 · P1: 0 · P2: 1 · P3: 4 (plus 3 labeled leads, not counted).
- The heavy rulings — events immutability, byte-identical marker
  replay, between-turn/expired/contradicted commit gating, no
  unwinding of committed rows, no warmth/bug inference from prefix
  facts, exact-prompt window capture, zod at receipt boundaries — all
  verified clean, with the test suite already pinning most of them.

> Audited 2026-10-23 18:20 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 18 — System One + responsibility/handover machinery

Scope read: `src/system1.ts`, `src/responsibilities.ts`,
`src/responsibility-feed.ts`, `src/responsibility-observer.ts`,
`src/responsibility-service.ts`, `src/reply-ratings.ts` and the seven
colocated suites (`system1.test.ts`, `responsibilities.test.ts`,
`responsibility-feed.test.ts`, `responsibility-observer.test.ts`,
`responsibility-service.test.ts`, `reply-ratings.test.ts`,
`handover-loop.test.ts`). Governing spec: `design/system1.md`,
`design/delegation.md` (bind-identity ruling), and the file-header
contracts of the scoped modules. Static reading only, per the operator
override — the orchestrator's verification pass (typecheck clean; 4686
pass / 0 fail / 86 skip) was not re-run. One scratch proof was written
and run: `/tmp/goblin-hunt-18-blocked.test.ts` (see Finding 1).

Counts: **P0: 0 · P1: 1 · P2: 0 · P3: 4**.

---

## 1. Findings

### P1-1 — Observer dedup collapses repeated blocked stints when the server reports no `state_change_seq`

- **Where:** `src/responsibility-observer.ts:323` —
  `sourceKey: key("blocked", cur.seq ?? "na")` (blocked branch
  321–335). Root context: cursor schema anticipates null seq
  (`observedCursorSchema`, :25 `seq: …nullable()`); the epoch/reset
  machinery that namespaces every other kind of key never engages on
  this path — the reset detector (:215) requires both `prev.seq` and
  `cur.seq` non-null, and only the missing branch (:194) and the reset
  branch (:217) bump the epoch. The blocked key is the only development
  key with a `"na"` fallback that can legitimately recur inside one
  epoch namespace.
- **Violated rule:** the observer's own file-header contract
  (`src/responsibility-observer.ts:1–14`): *"A repeated poll dedupes to
  nothing and spends no model call"* — dedup is for repeated polls over
  the same state, not for distinct developments; and the branch's
  in-code contract (:320) *"Blocked/input-needed is a development only
  on transition"* — every transition into blocked is a development. A
  second blocked stint is a new transition and must surface. The
  durable layer then enforces the wrong outcome:
  `work_events.source_key` is UNIQUE (`src/wake-store.ts:176`) and
  `wakes.record` silently dedupes an identical sourceKey+identity
  replay (`src/wake-store.ts:359–382`, returns `created: false`, no
  wake).
- **Triggering path:** bind an agent whose Herdr server reports
  `terminal_id` and `agent_session` but omits `state_change_seq` —
  `herdr.ts:421` declares it optional (*"older servers omit it"*), the
  bind gate (`src/agent/tools/responsibility.ts:192–203`) requires only
  terminal_id + agent_session, and `cursorFromAgent` seeds a null-seq
  cursor, so the attachment is fully inside the observer's supported
  envelope. Then: poll with status `blocked` (event fires, key
  `obs:{att}:g{g}:e0:blocked:na`) → poll `idle` (cursor only) → poll
  `blocked` again → the second genuine transition re-generates the
  *same* sourceKey, `wakes.record` dedupes it, and the cursor commits —
  so the stint is never surfaced, never re-tried, and no wake reaches
  the coordination lane. The model is never told the agent is blocked
  again; follow-through (the observer's core job) misses it.
- **Proof:** `/tmp/goblin-hunt-18-blocked.test.ts` (run with
  `bun test /tmp/goblin-hunt-18-blocked.test.ts` from the repo root):
  builds the standard observer rig with `state_change_seq: null`;
  stint 1 records one `blocked-candidate`; after idle, stint 2 records
  **nothing** — the run's log line is
  `"wake development deduplicated" … "sourceKey":"obs:1:g1:e0:blocked:na"`,
  and the test fails `expect(ev.length).toBe(2)` → received 1.
- **Catching test for the suite:** the scratch file verbatim, or add a
  `state_change_seq: null` variant to the existing blocked-transition
  test (`src/responsibility-observer.test.ts:348–357`) asserting two
  events and two distinct sourceKeys across blocked → idle → blocked.
- **Aggravator, same root:** with seq null the epoch can only ever bump
  via a missing cycle, never via a sequence reset — so on a seq-less
  server that resets, reused `completion_seq` numbers re-fire under the
  *same* epoch-0 namespace and `done-candidate` events dedupe against
  pre-reset rows (missed completions, the exact thing the epoch
  mechanism exists to prevent — file header: *"Source keys are
  namespaced by attachment generation and durable reset epoch so reused
  sequences survive … server resets"*).
- **Severity rationale:** P1 — wrong behavior on a plausible path: the
  path is within the adapter's and the cursor schema's supported
  envelope (null seq is anticipated in three places), and when it hits,
  a core development class is permanently invisible. If the operator's
  live Herdr always reports `state_change_seq`, the impact is latent
  rather than live (see §3).

### P3-1 — `attach()` does not enforce the bind-identity ruling at the store boundary

- **Where:** `src/responsibilities.ts:766–827` (`attach` accepts any
  `AttachmentTarget`, including `terminalId: null` / `agentSession:
  null` / `kind`-only).
- **Rule:** `design/delegation.md:163–166`: *"A new attachment binding
  requires both `terminal_id` and `agent_session`; without a harness
  session a same-kind replacement is undetectable, so session-less
  agents are refused."* Enforcement exists only in the tool
  (`src/agent/tools/responsibility.ts:192–203`) and at the send edge
  (`makeManagedSendEdge`, `src/responsibility-service.ts:148–156`,
  refuses null kind/session; `dispatch` :472–482 refuses null
  agentSession). A direct store consumer (tests today, any future
  route) can bind the degraded identity, at which point the
  unresolved-delivery fence identity (:655–664) degrades to
  (server, session, kind) — the *"never pane + kind alone, which a
  same-kind replacement inherits"* shape the file header itself names
  as the bug shape. Defense-in-depth gap, not a live break (production
  callers all pass through the tool gate). Pointer: herdr identity
  mechanics are hunt 9's scope.

### P3-2 — `dispatch()` returns a refusal without recording it when the attachment row vanished

- **Where:** `src/responsibility-service.ts:468–469` —
  `if (att === null) return { refused: "attachment-detached" }` leaves
  the operation `prepared` forever, while every other pre-dispatch
  refusal two lines above (:456–467) transitions it to `refused` with
  the named code. Inconsistent disposition: the op stays `prepared`
  (invisible in the refusal accounting; re-dispatchable if the row ever
  reappeared). Path is corruption-only today (nothing deletes
  attachment rows; detach only marks health), hence P3 not P2.

### P3-3 — `System1Decision` parses `output_tokens` and drops it

- **Where:** `src/system1.ts:49–50` (schema), `:250–254` (decision
  construction), `:55–60` (interface — `inputTokens` and `cost` only).
  The file-header wire contract says *"usage carries input/output
  tokens + cost"*, and the schema pins output_tokens, but no consumer
  can ever see it. Either surface it in `System1Decision` or stop
  parsing it. (Related nit: `usage` fields carry no non-negative
  bounds — a server reporting negative cost would flow into the
  decision's `cost` and the `system1 decision` log line.)

### P3-4 — `checkSendable` conflates `missing`/`identity_changed` into "attachment-detached"

- **Where:** `src/responsibilities.ts:703–704` — two consecutive ifs
  returning the same refusal for three distinct health states
  (`detached`, `missing`, `identity_changed`). A sender diagnosing a
  refusal cannot distinguish "operator detached it" from "observer
  marked it missing" from "replacement detected" — the feed and the
  tool both surface the richer state, so the store's own refusal name
  is the least informative read of the three. Also a trivial branch
  merge.

---

## 2. Checked and clean (later passes can skip)

- **System1 wire contract** (`src/system1.ts`): POST body
  `{model, state, questions}` exactly (test-pinned against the recorded
  alpha shape); responses validated with zod (`decisionsResponseSchema`
  + per-question `noulAnswerSchema`); missing answer, wrong type,
  out-of-range noul all → `protocol`; usage absent → null tokens/cost;
  1 MiB response cap; `redirect: "error"` keeps credentials off
  redirected services; error messages sanitize bodies/URLs/credential
  detail (test-asserted).
- **At most one backup:** single fallback branch; no fallback when the
  configured model *is* `FALLBACK_MODEL`; auth/401/403/aborted/no-time
  never fall back; primary gets half the remaining budget when fallback
  is possible, both attempts share one caller deadline (all
  test-pinned, `system1.test.ts:129–321`). Input serialized once before
  auth; auth resolved once per decide; wedged auth bounded by the same
  deadline.
- **Naming rule** (`design/system1.md` → Naming rule): `jev` appears
  only inside the model-id literal (`DEFAULT_MODEL`); all identifiers
  say `system1`.
- **Logging red lines** (system1.md → Logging): request/decision lines
  carry requestId, model, questionIds, inputHash, answers
  (probabilities), token/cost counts, ms — no state text, bodies,
  credentials, or endpoint URLs.
- **Handover-key idempotence:** store-level (`handover_key TEXT
  UNIQUE` + pre-read returns existing, replay's understanding ignored)
  and service-level (`accept` skips attachments/wake/setArmed on
  duplicate); no doubled attachments, events, or follow-up programs
  (tests in both suites + `handover-loop.test.ts:99–115`).
- **Revision-bumping corrections:** `revise` bumps revision inside
  `correct`'s single transaction together with every project lane's
  epoch fence and the correction wake; failure rolls all of it back;
  hooks run post-commit, one lane's failure never skips the others;
  correction trigger text names responsibility + revision (tested).
- **Generation fencing:** prepare snapshots generation + revision +
  dispatch identity; `validateForSend`/`claimForSend` re-check both;
  reattach bumps generation and refuses same-identity reattachment
  past an unresolved delivery; the dispatch-identity snapshot survives
  reattach and every migration crash window (mid-ALTER, backfill,
  partial columns, all-NULL) — the entire
  `responsibilities.test.ts` unresolved-fence block passes by design
  and matches the code.
- **Unresolved-delivery fence:** row-scoped (`qUnresolved`) AND
  identity-scoped (`qUnresolvedForIdentity`, `IS` for NULL
  comparability); attach-time duplicate-binding refusal
  (`qLiveBindingForIdentity`); detach→attach cannot mint past it;
  claim is the second fence; reconciliation (evidence-gated, idempotent
  replay, conflict-refusing) is the only escape; uncertain has no
  public terminal edge. Cross-process reconciliation mid-dispatch
  stands (test-pinned).
- **Identity-bound send path:** dispatch refuses null agentSession;
  the edge refuses non-local/`default` targets, null kind, null
  session; post-send identity compare (agent_session always, terminal
  when bound) lands mismatches as `uncertain`, never a resend; "a
  timeout is not non-delivery" holds (no code path converts an error
  outcome into not-delivered).
- **Reply-ratings record-only** (`src/reply-ratings.ts` header): repo-wide
  consumer sweep — writes only from the Telegram tap
  (`src/tg/rate-button.ts:110`) and the app tap
  (`src/http/app-conversations.ts:876`); reads (`latest`,
  `latestEvent`, `listApp`) serve only the app UI wire
  (`ratedReplies`) and tests; no reads in `src/agent/`, memory,
  FTS, or conversation-history assembly (`src/conversation.ts` touches
  the table only to own/migrate its schema; the history-exclusion join
  lives in the test, `reply-ratings.test.ts:188–195`). Vote change is
  a new row; latest-wins reads verified incl. across reopen and the
  legacy-column migration. **No P1 record-only violation exists.**
- **Feed read model drift:** window semantics correct (newest 50
  ascending, `eventsTruncated = total − rows`, rows never pruned);
  the wake JOIN cannot fan out (record() links each event to exactly
  one wake; `qLinkEvent` has no other caller); `lastActivityAt` =
  newest window row's createdAt; arm truth overridden via `armedView`
  (documented design: persisted flags lag, the linked program is the
  truth) and `nextCheckinAt` consistent with it; `feedOpen` =
  `resps.open()` (paused included, by design); project feed includes
  closed responsibilities with full history (by design,
  `handover-loop.test.ts:153–162`).
- **Observer invariants beyond Finding 1:** one bounded snapshot per
  (server, session) group with JSON-encoded group keys (no
  concatenation collision); HerdrError = skipped group ≠ missing;
  unexpected errors skip only their group, rethrow after the pass,
  pump still runs; reconcile re-reads authority AND cursor in the
  transaction (in-flight detach/reattach/pause/close all win, tested);
  missing fires once per disappearance and mints a fresh epoch
  namespace; recovered/reset/identity/baseline precedence is coherent;
  a null cursor baselines the first poll; hostile names ride the
  neutralizing fence (test-asserted); mutation failure rolls back
  cursor+health+event+wake together; one pass at a time (`inflight`).
- **Service accept/correct/ensureFollowup:** accept is one transaction
  with the unarmed-baseline write inside and the follow-up link
  post-commit (SQLITE_BUSY reasoning verified by the same-file
  connection test); the boot relink sweep the comment names exists
  (`src/index.ts:626–636`); orphan adoption keyed by kind/name only
  (independent programs neither adopted nor silenced — tested); twins
  collapse to one enabled row; dispatch races (overlap, cross-process
  claim, mid-preflight cancel/revise/fence) all land as tested.

---

## 3. Could not verify / no written source found

- **Live impact precondition of P1-1:** whether the operator's actual
  Herdr deployment reports `state_change_seq`. The herdr live drift
  check is env-gated and out of engagement rules; the adapter's
  optionality is the only evidence. If the live server always reports
  seq, P1-1 is latent (still one adapter upgrade away).
- **The OpenRouter Decisions alpha wire shape** itself: pinned only by
  the recorded fixture comment (`system1.test.ts:22–30`, "2026-09-21");
  no live call permitted. Response-schema tolerance of extra fields
  (`id`, `model`, `provider`) is correct for the recorded shape.
- **System1 consumers' fail-open/fail-closed semantics** (skill-review
  gate fallback, injection-checker "unavailable", rolling DM, loop
  watchdog) live outside the scoped files — pointers only, per brief:
  reviewer = hunt 17, mail injection = hunt 12, loop watchdog = hunt 2.
- **No design-doc home for the observer/blocked semantics beyond the
  file header:** `design/system1.md` rules the typed-decision layer;
  the responsibility machinery's written contracts are the module
  headers plus `design/delegation.md`'s bind-identity ruling.
  Finding 1 is cited against the observer's header contract (which the
  brief sanctions as spec), not against a design/ doc — I found no
  `design/*.md` section that states the blocked-transition rule, and I
  am not inventing one.
- **Loopback endpoint `/api/check-injection`** (system1.md → The
  loopback endpoint): in `src/http/`, out of scope, not inspected.

---

## Simplifications & code smells (operator-added section)

1. **Dead parse: `output_tokens`** — `src/system1.ts:50` schema-pins
   it; no field of `System1Decision` (:55–60) or log line carries it.
   Drop the schema field or surface it (see P3-3).
2. **Stale/misleading doc on `Attachment.baseline`** —
   `src/responsibilities.ts:90–91` says *"the reference the observer
   diffs against"*, but the observer never reads `baseline`
   (grep-verified: zero reads outside attach/reattach writes and
   tool/feed payloads); `att.cursor` is the diff reference
   (`src/responsibility-observer.ts:177`). The comment describes the
   pre-cursor-seeding design and now misleads.
3. **Double program fetch in the feed item** —
   `src/responsibility-feed.ts:134–138`: `armedView` already resolved
   the linked program internally; `item()` fetches it again for
   `nextRun`. Let `armedView` return the program (or its `nextRun`)
   and the duplication and the subtle re-check-skew
   (`item`'s fetch omits armedView's `responsibilityId ===` guard —
   currently harmless only because `arm.armed` gates the read) both
   disappear.
4. **Duplicated refusal branch** — `src/responsibilities.ts:703–704`
   (see P3-4): mergeable ifs returning the same name for three
   distinct health states.

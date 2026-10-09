# The turn — decomposition ruling (W3.0)

Part of the goblin design spec. The core — domain model, authority rule,
cache stability — is [`DESIGN.md`](../DESIGN.md); the turn's loop bounds
are `design/model.md` → "No step budget", its streaming contract is
`design/app.md` → "Streaming members & resumable streams". This file
rules how `runTurn` decomposes (REFACTOR-PLAN.md → W3): the phase cut,
state ownership, the recursion→loop conversion, the module map, and the
test migration. It is a ruling, not a proposal — W3.1+ implements it,
deviations come back here first.

Code anchors are `src/runtime.ts` at `ca886a7`: `runTurn` spans
**998–2177** (~1,180 lines), recursive (self-call at 2146).
`runtime.test.ts` is 3,987 lines / 87 tests. Line numbers drift; the
named shapes are the anchor.

## Why a ruling, before code moves

One function currently owns eight phases, all turn state lives as
rebound locals shared with SDK callbacks, and the only test surface is
the whole runtime end-to-end (#91). Decomposing that without written
boundaries reproduces the v1 disease: seams argued per-commit drift
into whatever the day's diff finds convenient. The rulings below fix
the boundaries now.

## The turn, phase by phase

One **logical turn** = one enqueue-to-onDone unit of work. One
**attempt** = one pass of the model loop; a logical turn has at most two
attempts (overflow resume, below). Phases of an attempt:

| # | Phase | Lines today | Inputs | Outputs |
|---|-------|-------------|--------|---------|
| 0 | recovery-restore | 1006–1052, 1072–1077 | `TurnRecovery?` (318–337) | restored loop state, wire log, membership claim |
| 1 | admission | 1054–1068, 1082–1118 | convId, lane queue, recovery?.conversation | immutable `AdmissionSnapshot`: conv, epoch, entries, anchorSeq, steer-mark seed, clock start |
| 2 | recall | 1124–1142 (body 764–853) | snapshot, memory deps, abort signal | `{prior, current}` recall contexts |
| 3 | prompt/view assembly | 1144–1259 | snapshot, recall, partial?, ModelStep | `ModelMessage[]` (converted, merged) + fenced tools |
| 4 | stream setup | 1261–1716 | view, TurnState, deps | live `streamText` result + `prepareStep`/`onError`/`onStepEnd` closures |
| 5 | streaming callbacks | 1718–1864 | uiStream chunks, TurnState | wire-log growth, sink deltas, loop verdicts, attempt outputs |
| 6 | finish/persist/review | 1881–2083 | attempt outputs, steer mark, snapshot | stored reply + retention enqueue, onDone(completed), reviewer snapshot, threshold signal |
| 7 | overflow resume | 1866–1880, 2091–2160 | `ContextOverflowError` (339–352) | compaction + `TurnRecovery` → next attempt |

Error rails around them: fenced (2086–2090, quiet abort + fenced
onDone), generic (2161–2176, abort + error onDone). Both are terminal —
they belong to the attempt loop, not to a phase module.

Seams each phase already has, or lacks:

- **0 recovery-restore** — has: `TurnRecovery` is an explicit serialized
  shape; `LoopDetector.restore` (loop-detect.ts). Lacks: the membership
  claim (1072–1077) is queue surgery inline — and it is bug #96: it
  claims streaming members without replaying `live.chunks`, unlike the
  steering path (1384–1397) which replays.
- **1 admission** — has: the ownership filter (`queuedIds`, 1102–1103)
  and anchor derivation are already a coherent block with the ruling in
  comments (#82). Lacks: it is interleaved with lane/controller pinning
  (1116–1118), which is runtime-owned, not admission's. Ruling for the
  cut: admission's resume claim (1072–1077) must invoke the stream
  driver's membership seam — claim + `live.chunks` replay — through the
  same runtime-injected queue function used by the steer path, with
  `live` passed in. Never splice `lane.pending` directly.
- **2 recall** — has: `recallMemory` is a self-contained method over
  injected memory deps, fail-open by construction. Lacks: it lives on
  Runtime though everything it touches is memory's surface.
- **3 view assembly** — has: pure functions already exist
  (`withMemoryBlocks`, `materializeAttachments`, `mergeConsecutiveUserModels`
  2269, `systemEventAsUser` 155, `unconvertiblePlaceholder` 134). Lacks:
  the composition is inline, so byte-stability (Cache stability) has no
  unit to pin.
- **4/5 stream setup + callbacks** — has: the SDK's callback surface is
  itself the seam; `LiveChunks` (378) is a real wire-log object. Lacks:
  every callback closes over ~15 rebound locals (the inventory below);
  there is no object to call a method on.
- **6 finish** — has: `retentionSourceFrom` (2210) and `retentionOpt`
  (855) are already projections with rulings in comments. Lacks: the
  reviewer snapshot, defiance guard, and window signal are inline.
- **7 overflow resume** — has: `ContextOverflowError` carries exactly
  the recovery payload; `hasContent` (2292) gates the partial. Lacks:
  it is a recursive self-call — stack depth stands in for control flow,
  and `turns` travels by reference, invisibly.

## State ownership, by lifetime

The rule that keeps TurnState from being the giant function in an
object costume: **state is classified by who survives it.**

1. **Conversation-scoped** — owned by the Runtime (or its `Lane`),
   survives turns: `lanes` (pending/compacts/running/controller/
   compactController/draining/live), `closed`, `reviewer`,
   `loopWatchdog`, `turnCounter`, `lastTurns`. None of it is turn
   state; modules receive it only as injected dependencies or callback
   seams (e.g. the driver steers through a runtime-provided function,
   never touching the lane).
2. **Recovery-carried** — exactly what `TurnRecovery` (318–337)
   serializes: `conversation`, `partial`, `memory`, `seenText`,
   `toolCalls`, `digest`, `loop` (`detector`, `watchdogRing`,
   `watchdogStrikes`, `completedCalls`, `warnings`, `cutKind`,
   `forcedKind`), `startedAt`, `live`, `filterRetryUsed` — plus the
   membership array `turns`, which today travels the same seam by
   reference. **This list is the exhaustive whitelist: anything not on
   it dies with the attempt.** That is a feature — an in-flight
   watchdog verdict or a half-set display seam must not leak into the
   resumed attempt — and the extraction must not "fix" it by widening
   the type.
3. **Attempt-scoped** — everything else. Owned by one `TurnState`
   object per attempt, mutated only through narrow methods; callbacks
   call methods, they never rebind locals. `TurnState.snapshot()`
   projects to `TurnRecovery` — the whitelist above is literally the
   projection's field list.
4. **Not state** — the admission snapshot (conv, epoch, entries,
   anchorSeq, queuedIds) is immutable input to the attempt, and
   everything derived from it per attempt (view, messages, merged) is a
   value. Inputs and values get no setters and no methods.

### The inventory

Every local of `runTurn`, classified. RC = recovery-carried, AT =
attempt-scoped (TurnState), CS = conversation/runtime-scoped, — = input
or derived value, not state.

| Local | Line | Class | Disposition |
|---|---|---|---|
| `convId` | 998 | — | immutable input |
| `turns` (membership) | 999 | RC | travels the resume seam; grows on steer (1377) and resume claim (1076); rides the resume decision explicitly |
| `recovery` | 1000 | — | the seam's wire format |
| `filterRetryUsed` | 1008 | RC | retry budget survives the resume (model.md → provider-filter recovery) |
| `detector` | 1010 | RC | `loop.detector`, restored |
| `watchdogRing` | 1011 | RC | `loop.watchdogRing` |
| `watchdogStrikes` | 1012 | RC | `loop.watchdogStrikes` |
| `watchdogInFlight` | 1013 | AT | a check in flight when the attempt dies is void — must not land in the resume |
| `completedCalls` | 1014 | RC | `loop.completedCalls` (cadence counter) |
| `warnings` | 1019 | RC | `loop.warnings`; restored warnings re-send once per attempt |
| `warnCursor` | 1020 | AT | per-attempt send cursor (the "once" above) |
| `cutKind` | 1023 | RC | `loop.cutKind`; a cut the failed attempt decided still cuts the resume |
| `landingIssued` | 1026 | AT | the landing re-issues in the resume attempt (stopWhen reads it) |
| `forcedKind` | 1029 | RC | `loop.forcedKind`; the stamp covers the whole logical turn |
| `watchdog` | 1033 | CS | read-only ref to Runtime config (`loopWatchdog`) |
| `sink` | 1039 | — | derived: `turns[0].sink`, fixed at enqueue |
| `live` | 1044 | RC | the wire log — subscribers must see the resume continue the same wire |
| `notifyAll` | 1049 | — | behavior: `TurnState.finish(done)` + runtime's `notifyDone` loop |
| `conv` | 1054 | RC | `TurnRecovery.conversation` (a resume keeps the same conversation object); the admission-snapshot VALUE read off it (settings captured once per logical turn, 1060) is immutable |
| `epoch` | 1068 | — | the authority token, frozen at admission |
| `turnStartMs` | 1082 | RC | `startedAt`; a resume continues the failed attempt's clock |
| `queuedIds` | 1102 | — | admission input (the #82 ownership filter) |
| `entries` / `history` | 1103–1104 | — | admission snapshot |
| `anchorSeq` | 1108 | — | admission output; recall + causal key |
| `steerHighWater` | 1113 | AT | seeded at admission, advanced by claimed steers (1442–1444); NOT carried — the resume's fresh snapshot contains the steered rows as durable history, so it re-derives |
| `controller` + lane pins | 1116–1118 | AT / CS | attempt owns the controller; the lane slots are Runtime-owned |
| `memory` | 1124 | RC | recall must not re-run on a moved snapshot |
| `deliverVoice`/`deliverFile`/`recording` | 1145–1170 | — | attempt wiring: closures rebuilt per attempt over the frozen epoch |
| `accepts` | 1161 | AT | mutable ref filled when `buildStep` lands (1182–1187) |
| `tools` | 1175 | AT | built + fenced per attempt |
| `step` | 1180 | — | computed per attempt from the admission snapshot (settings fixed across the resume, model.md → selection scope) |
| `view`/`prepared`/`messages`/`merged` | 1193–1247 | — | derived values; the cache-stability surface |
| `lastStepInputTokens` | 1261 | AT | window-utilization numerator |
| `rawError` | 1265 | AT | classifier input (body/cause chain) |
| `filterRetryPending` | 1266 | AT | onError→onStepEnd handshake within one attempt |
| `result` / `uiStream` | 1267 / 1579 | AT | the attempt's streams |
| `responseMessage` | 1543 | AT | attempt output |
| `partialResponse` | 1547 | RC* | attempt output that becomes `recovery.partial` on overflow |
| `toolCalls` | 1552 | RC | reviewer gate state spans the logical turn |
| `evidence` | 1558 | CS | read-only ref to reviewer config |
| `digestRing` | 1559 | RC | reviewer evidence spans the logical turn |
| `lastTextPartId` | 1567 | AT | display seam (block separator) |
| `seenText` | 1568 | RC | a continued text block must not get a phantom separator |
| `streamError` | 1573 | AT | terminal for this attempt |
| `holdForRecovery` | 1578 | AT | holds the failure off the wire for this attempt |
| `callById` | 1644 | AT | the failed attempt's calls return as `partial` parts, not chunks |
| `usage` / `finishReason` | 1893 / 1900 | — | attempt outputs |
| `finalEntries` / `finalAnchor` / `finalSource` | 1910–1931 | — | completion-time derivation over the steer mark |
| `memoryOpt` / `window` | 1962 / 1974 | — | derived; `window` feeds the threshold signal |
| `turnSeq` / reviewer `snapshot` | 2031–2032 | CS | Runtime's counter + the submission value |

RC* marks the one borderline: `partialResponse` is attempt output while
the attempt lives and recovery payload the moment it overflows — it
rides the `ContextOverflowError`, which is correct, and stays that way.

## Recursion → driven loop

The self-call (2146–2159) becomes a returned decision consumed by a
loop. `runTurn` remains the logical-turn entry `drain` calls (939); it
gains (or delegates to) the attempt loop:

```ts
type AttemptOutcome =
	| { kind: "done" }
	| { kind: "resume"; recovery: TurnRecovery; turns: QueuedTurn[] };

// inside runTurn, replacing the recursive branch:
for (let recovery: TurnRecovery | undefined; ; ) {
	const outcome = await this.runAttempt(convId, turns, recovery, live);
	if (outcome.kind === "done") return;
	recovery = outcome.recovery;
	turns = outcome.turns;
}
```

Rulings:

- `TurnRecovery` stays the wire format between attempts — the loop adds
  no new state channel; `turns` stops traveling by reference and rides
  the decision.
- One recovery per logical turn stays a property of the overflow
  classifier (`recovery !== undefined` ⇒ a second overflow is a
  terminal error, 2167–2170), not of the loop; the loop is written
  unbounded so the invariant lives in exactly one place.
- The epoch re-check before iterating (2138–2144) lives in the overflow
  recovery's packaging step (`turn/overflow.ts` → recoverFromOverflow,
  between the compaction and the resume decision) — before the loop
  hands the recovery to the next admission.
- One logical turn, one loop history — unchanged (model.md → carried
  from the first ruling's review round). The loop is where that sentence
  becomes visible.
- The `live` wire log is created by `runTurn` (logical-turn scope) and
  handed to each attempt, not re-created — it is recovery-carried state
  that today survives only by the accident of recursion.

## What must not change

Behavior-preserving is the contract; these are the invariants a
behavior-preserving refactor can still break, so they are named here
and the W3 review checkpoints audit them specifically.

- **The authority rule** (DESIGN.md). `checkAuthority` around every
  await — 16 sites inside `runTurn` today (1126…2140) plus the
  epoch-compare guards in `prepareStep` (1349) and the steer error path
  (1404); `fenceTools` (748) around every tool execute;
  `sink.setAuthorityCheck` (1083); delivery-time checks in the queued
  Telegram action path. Extraction rule: a phase module either runs
  between two checks (pure/derived work) or receives the check as an
  injected `assertAuthority` (the shape `doCompact` already uses, 686).
  No extracted await may exist outside one of these two arrangements.
  Corollary (#115, found by the rollout-hold review): an await is
  fenced on BOTH sides, success path included — a steer whose
  conversion succeeds must still re-compare the epoch before joining,
  replaying, or folding its content into the next request. Preserving
  the check *sites* through an extraction is not the same as proving
  the rule; every new await re-earns its post-await check.
- **Cache stability** (DESIGN.md). Prompt assembly stays byte-stable:
  the view is a pure function of (snapshot, recall, partial, step);
  steering appends tails only — prefix bytes untouched; the merge runs
  after per-message conversion; no clock, no per-turn variability. The
  view module's boundary tests pin bytes; the sanctioned one-time
  rewrites (DESIGN.md → Cache stability) remain the complete list of
  legal hash moves.
- **Admission semantics.** Snapshot-at-admission (a `/compact` landing
  mid-turn can't rewrite what the turn sees); recall is admission-time
  and never re-runs for steered input; the reply's anchor, retention
  source, and reviewer evidence read the exchange as ended, bounded by
  the ownership mark. The #82 ruling — durability is not ownership —
  means the `queuedIds` filter (1102–1103) is **admission's**, not the
  view builder's: the view module receives already-owned entries and
  cannot express "read what is merely durable", so the bug class cannot
  reappear as a view-layer convenience.
- **The sink contract.** Exactly one `onDone` per submit — completed,
  fenced, or error — including drops by `/stop` and the drain crash
  guard (940–963). `notifyDone`'s `doneSent` guard (727–736) and
  `QueuedTurn` stay runtime-owned; `TurnState.finish` is the single
  exit every path funnels through.
- **Streaming members and join replay** (design/app.md). Chunk fan-out
  to every streaming member at one emission point; a throwing sink is
  detached, never fatal; the wire log records exactly what the wire saw;
  a held failure (overflow) takes its error chunk and everything after
  it off the wire. **The #96/F3 fix rides the stream-driver seam**: the
  claim-then-replay of streaming members must be one mechanism with one
  home — the driver's membership seam — used by both call sites
  (`prepareStep` steering and the overflow resume claim). The fix
  itself lands first (W1, red → green on the current shape); the
  extraction carries the regression test, and the extraction is what
  makes the second call site unable to forget the replay. **Ruling
  (#114, a W3 extraction regression): registration rides the same
  seam** — a claimed member enters the attempt's membership list at
  the splice, never when admission returns. The gap between claim and
  return is where a store read failure orphaned a joiner (claimed,
  untracked, stream hanging forever); with registration at the splice,
  every exception path — including drain's crash guard — settles it.

## Module cut (W3 target)

New directory `src/turn/`; `runtime.ts` keeps the queue, the attempt
loop, and `checkAuthority`. Flat files, one job each, tests colocated.

| Module | One job | Absorbs (current lines) |
|---|---|---|
| `turn/state.ts` | `TurnState`: owns the attempt — AT-class state with narrow methods; `snapshot(): TurnRecovery` | the AT column above; `TurnRecovery`/`LoopTurnState` types (300–337) |
| `turn/state.ts` | `TurnState`: owns the attempt — the loop machinery (detector verdicts, watchdog ring/cadence/strikes, warn + cut text, context-landing decision) plus AT-class state with narrow methods; `snapshot(): LoopTurnState`. The planned `turn/loop.ts` merged here at seam 1 | the AT column above; `TurnRecovery`/`LoopTurnState` types, `noteCompletedCall`, `CUT_NUDGE`/warning consts, landing logic in `prepareStep` |
| `turn/admission.ts` | fix what this attempt owns, sees, and answers: settings capture, epoch, resume claim, ownership filter, anchor, mark seed, clock | 1054–1118 (minus lane pinning), 1072–1077 |
| `turn/view.ts` | pure model-view assembly: snapshot + recall + partial + step → byte-stable `ModelMessage[]`; single-message variant for steers | 1193–1259; `systemEventAsUser`, `unconvertiblePlaceholder`, `mergeConsecutiveUserModels` (134–165, 2269–2290) |
| `turn/stream.ts` | drive one attempt's wire: streamText/toUIMessageStream wiring, `prepareStep` (steer fold + warnings + nudge), `onError`/`onStepEnd`, the chunk loop, fan-out, wire-log append, join replay, display deltas | 1261–1864; `LiveChunks`/`endLive` (378–386, 2183–2199) |
| `turn/overflow.ts` | turn a failed attempt into a resume decision or a terminal error: classify, `hasContent`, package `TurnRecovery`, give-up messages | `ContextOverflowError` (339–352), `hasContent` (2292), 2091–2160's decision half |
| `turn/finish.ts` | land a completed attempt durably: ownership-bounded anchor + retention source, defiance guard, persist + retention enqueue, window signal, reviewer snapshot | 1881–2083; `retentionOpt` (855–913), `DEFIANCE_NOTE` |

Two moves into existing modules, not new ones:

- `recallMemory`'s body (764–853) → `memory.ts` (its whole surface is
  memory's: client, contexts, `noteRecall`; the module map already says
  "recall contexts"). Runtime calls it between authority checks.
- `retentionSourceFrom` + `RetentionSource` (2203–2261) → `memory.ts`,
  per the two-projections ruling below.

Stays in `runtime.ts`: the `Lane` map and queue (`submit`/`admit`/
`drain`/`claimableCount`), `stop`/`shutdown`/`cancelFenced`,
`compact`/`doCompact`, `checkAuthority`/`fenceTools`, `notifyDone`,
the attempt loop, and the ~150-line `runTurn` orchestration that calls
the phases in order. The driver steers through a runtime-injected
function (queue policy — `claimableCount` — never leaves runtime.ts),
and persists through a runtime-injected append; no `turn/` module sees
a `Lane`.

Signal, not gate (REFACTOR-PLAN.md → W3 acceptance): `runTurn`
orchestration lands around ≤150 lines; the gates are structural —
every phase unit-testable in isolation, no callback rebinds a shared
local, the self-call gone, suite green throughout.

## Test migration

`runtime.test.ts` (3,987 lines) sheds weight as modules gain boundary
tests; useful coverage is never deleted to hit a number. Describe
blocks → destination:

| describe (line) | Destination |
|---|---|
| provider-filter retry (191) | `turn/stream.test.ts` (callback-directed retry, budget in state) |
| turn authority (645) | **stays** — the e2e net; authority is cross-phase by construction |
| context overflow recovery (1379) | split: classify/package → `turn/overflow.test.ts`; resume loop + lane interplay stays e2e |
| cache stability (1621) | split: view bytes → `turn/view.test.ts`; cross-turn prefix cases (steer append-only, failed-boundary burst merge) stay e2e |
| skill reviewer hook (2465) | `turn/finish.test.ts` (snapshot, exclusion, prior-turn chain) |
| steering (2896) | split: `prepareStep` fold mechanics → `turn/stream.test.ts`; ownership-mark semantics stay e2e |
| live chunk subscription (2942) | `turn/stream.test.ts` (wire log, replay, end semantics); the `subscribeLiveChunks` HTTP contract stays e2e |
| app channel (3179) | **stays** — channel boundary |
| streaming lane boundary (3247) | **stays** — queue policy (`claimableCount`) |
| loop landings (3372), loop watchdog (3542) | `turn/state.test.ts` (restore/inherit; the planned `turn/loop.test.ts` merged into state at seam 1) |
| forced-landing defiance guard (3738) | `turn/finish.test.ts` (+ stamping in state) |

The stays-list is the permanent e2e net: authority, cross-turn cache
behavior, channel and queue boundaries, drain/stop/shutdown, and the
overflow resume loop. Target signal ~1,200 lines (plan W3), suite
smaller than `src/` overall (DESIGN.md → Test posture).

## The two text projections (#84 / #111)

Known tension, ruled here so W6's dedup sweep cannot unify it blindly:
compaction's serialization (`agent/compaction.ts` `messageText`)
embeds stored voice/video-note transcripts — durable operator speech,
#84 — and since #111 memory's retention projection (`memory.ts`
`messageText`) embeds them too: `design/memory.md` → Retain rules a
stored transcript is the text of the exchange, not attachment
ingestion. The two jobs still differ in what else rides: compaction
folds **model-context continuity** (losing a spoken instruction there
degrades every future turn), so bare attachment path references and
bounded tool evidence stay; retention builds **operator memory**, so
transcript-less attachments and raw tool output stay out.

Where the divergence lives in the cut: **two files, two design docs,
one seam each.** Compaction's projection stays in `agent/compaction.ts`
(cited by DESIGN.md → Compaction); the retention projection —
`messageText`, `buildRetentionDocument`, and the incoming
`retentionSourceFrom` — consolidates in `memory.ts` (cited by
`design/memory.md` → Retain). `retentionSourceFrom` therefore moves to
`memory.ts`, not into `turn/view.ts` or `turn/finish.ts`: co-locating
it with the model-view builder is how the projections would silently
fuse. #111 is now ruled, so W6 may share the transcript mechanics
between the two — the content divergence above stays decided per
file, and "which projection am I in" remains answerable by file
alone.

## Acceptance

Structural, from the plan: every extracted phase unit-testable in
isolation; no callback rebinds a shared local (state changes go through
`TurnState` methods); the overflow self-call is gone (resume is a
returned decision consumed by a loop); the #96 regression test and the
whole pre-existing suite stay green throughout. Review checkpoints
after this note and after the recursion→loop conversion audit the
authority rule and cache stability specifically. Reported signals at
the end: `runTurn` orchestration size (~150), `runtime.ts` size,
`runtime.test.ts` size (~1,200), suite-to-product ratio (falling under
0.85, toward smaller-than-src).

# The turn — architecture ruling

Part of the goblin design spec. The core — domain model, authority rule,
cache stability — is [`DESIGN.md`](../DESIGN.md); the turn's loop bounds
are `design/model.md` → "No step budget", its streaming contract is
`design/app.md` → "Streaming members & resumable streams". This file
rules how `runTurn` decomposes: the phase cut, state ownership, the
attempt loop, and the module map under `src/turn/`.

Provenance: written as the W3.0 decomposition ruling while `runTurn`
was one ~1,180-line recursive function with all turn state in rebound
locals; the decomposition landed 2026-10 and this is now the
architecture law, not a plan — deviations come back here first.

## The turn, phase by phase

One **logical turn** = one enqueue-to-onDone unit of work. One
**attempt** = one pass of the model loop; a logical turn has at most two
attempts (overflow resume, below). Phases of an attempt:

| # | Phase | Inputs | Outputs |
|---|-------|--------|---------|
| 0 | recovery-restore | `TurnRecovery?` | restored loop state, wire log, membership claim |
| 1 | admission | convId, lane queue, recovery?.conversation | immutable `AdmissionSnapshot`: conv, epoch, entries, anchorSeq, steer-mark seed, clock start |
| 2 | recall | snapshot, memory deps, abort signal | `{prior, current}` recall contexts |
| 3 | prompt/view assembly | snapshot, recall, partial?, ModelStep | `ModelMessage[]` (converted, merged) + fenced tools |
| 4 | stream setup | view, TurnState, deps | live `streamText` result + `prepareStep`/`onError`/`onStepEnd` closures |
| 5 | streaming callbacks | uiStream chunks, TurnState | wire-log growth, sink deltas, loop verdicts, attempt outputs |
| 6 | finish/persist/review | attempt outputs, steer mark, snapshot | stored reply + retention enqueue, onDone(completed), reviewer snapshot, threshold signal |
| 7 | overflow resume | `ContextOverflowError` | compaction + `TurnRecovery` → next attempt |

Error rails around them: fenced (quiet abort + fenced onDone) and
generic (abort + error onDone). Both are terminal — they belong to the
attempt loop, not to a phase module.

Seam rulings that bind the phases:

- Phase 0/1's resume claim must invoke the stream driver's membership
  seam — claim + `live.chunks` replay — through the same
  runtime-injected queue function the steer path uses, with `live`
  passed in. Never splice `lane.pending` directly. (#96)
- Phase 1's admission fix (ownership filter, anchor) is distinct from
  lane/controller pinning, which is runtime-owned, not admission's.
- Phase 2's recall body lives in `memory.ts` — its whole surface is
  memory's (client, contexts, `noteRecall`); the runtime calls it
  between authority checks.
- Phase 3's view is composed only of pure functions over its inputs —
  that is what gives Cache stability a unit to pin.

## State ownership, by lifetime

The rule that keeps `TurnState` from being the giant function in an
object costume: **state is classified by who survives it.**

1. **Conversation-scoped** — owned by the Runtime (or its `Lane`),
   survives turns: `lanes` (pending/compacts/running/controller/
   compactController/draining/live), `closed`, `reviewer`,
   `loopWatchdog`, `turnCounter`, `lastTurns`. None of it is turn
   state; modules receive it only as injected dependencies or callback
   seams (e.g. the driver steers through a runtime-provided function,
   never touching the lane).
2. **Recovery-carried** — exactly what `TurnRecovery` serializes:
   `conversation`, `partial`, `memory`, `seenText`, `toolCalls`,
   `digest`, `loop` (`detector`, `watchdogRing`, `watchdogStrikes`,
   `completedCalls`, `warnings`, `cutKind`, `forcedKind`), `startedAt`,
   `live`, `filterRetryUsed` — plus the membership array `turns`,
   which rides the resume decision. **This list is the exhaustive
   whitelist: anything not on it dies with the attempt.** That is a
   feature — an in-flight watchdog verdict (`watchdogInFlight`) or a
   half-set display seam (`lastTextPartId`, `callById`) must not leak
   into the resumed attempt. Other deliberate deaths: `warnCursor`
   (restored warnings re-send once per attempt), `landingIssued` (the
   landing re-issues in the resume attempt — `stopWhen` reads it), and
   `steerMark` (the ownership mark is *not* carried — the resume's fresh
   snapshot contains the steered rows as durable history, so it
   re-derives). `partialResponse` is the one borderline: attempt output
   while the attempt lives, recovery payload the moment it overflows —
   it rides the `ContextOverflowError`, which is correct.
3. **Attempt-scoped** — everything else. Owned by one `TurnState`
   object per attempt, mutated only through narrow methods; callbacks
   call methods, they never rebind locals. `TurnState.snapshot()`
   projects the loop slice of `TurnRecovery` — the whitelist's `loop`
   entry is literally the projection's field list.
4. **Not state** — the admission snapshot (conv, epoch, entries,
   anchorSeq, queuedIds) is immutable input to the attempt, and
   everything derived from it per attempt (view, messages, merged) is a
   value. Inputs and values get no setters and no methods.

## The attempt loop

The recursion is a returned decision consumed by a loop. `runTurn`
remains the logical-turn entry `drain` calls; it creates the `live`
wire log once at logical-turn scope and hands it to each attempt, then
loops:

- `runAttempt` returns `done` or `resume{recovery, turns}`.
- `TurnRecovery` is the wire format between attempts — the loop adds
  no new state channel; `turns` rides the decision, never a shared
  reference.
- One recovery per logical turn is a property of the overflow
  classifier (`recovery !== undefined` ⇒ a second overflow is a
  terminal error), not of the loop — the loop is written unbounded so
  the invariant lives in exactly one place.
- The epoch re-check before iterating lives in `turn/overflow.ts`'s
  `recoverFromOverflow`, between the compaction and the resume
  decision — before the loop hands the recovery to the next admission.
- One logical turn, one loop history — unchanged (model.md →
  review-round rulings). The loop is where that sentence is visible.

## The turn journal

`src/turn-journal.ts` is the crash journal: two tables on the
conversation store's handle (`turn_runs`, `turn_tool_calls`) that
durably record what an admitted turn owned — epoch, anchor, settings
snapshot, tool surface — and how far each tool call got
(`planned → dispatched → completed|failed`). The run row lands before
any tool side effect can execute; `dispatched` without a result is
the ambiguous state — the side effect may or may not have happened.
A graceful shutdown fences its live rows first, so a row still
`running` at open means the process died mid-turn: open reclassifies
it `interrupted` and boot sends each operator one terse notice per
run (counts by state, never the partial itself). Nothing replays
automatically — boot is notice-only, and an `interrupted` turn
resumes ONLY by explicit operator decision, into a FRESH admission
(new epoch, new run row linked by `resumed_from`). Each attempt gets
its own run row, so an overflow resume leaves the failed attempt's
record intact — and the continuation's row INHERITS the failed
attempt's settled calls (as a fresh admission inherits its source's),
so a crash of the continuation still resumes with every side effect
the logical turn already recorded. Evidence handoff is one
transaction: the successor row's creation, the inheritance of settled
calls, and the source's consumption commit together — a crash between
the writes can never leave two interrupted runs where the successor
re-executes recorded effects. A call the fence answered from recorded
evidence journals with replay provenance (`replayed`); replay credits
count executions only, so one execution keeps exactly one replay
across any number of resumes.

`src/turn-resume.ts` owns the operator half (`makeResumeOps`): list
interrupted runs, take per-call decisions, abandon, resume. Both
surfaces — Telegram `/resume` `/decide` `/abandon` and the app's
`/interrupted` `/decide` `/resume` routes — drive the same `ResumeOps`.
The preconditions resume refuses on: undecided `dispatched` calls
(each needs `record-result` | `authorize-retry` | `skip`), model or
thinking drift against the run's recorded snapshot, any recorded tool
missing from the rebuilt surface, a busy lane, and a source that is
not `interrupted`. In the resumed attempt the fence replays recorded
outputs for `completed`/`resolved-done` calls (the tool never runs),
`resolved-retry` and `planned` calls execute normally, and
`resolved-skip` calls carry a refusal map — a re-ask gets the
operator's decline as the result, never the side effect. The model
sees only what the journal says happened. The source row flips to
`resumed` only inside the successor row's creation transaction; a
headless resumed turn notifies operators on terminal `onDone`.

## What must not change

These are the invariants a refactor can still break silently; they are
the audit list for any turn-structure change.

- **The authority rule** (DESIGN.md). `checkAuthority` around every
  await, plus the epoch-compare guards in `prepareStep` and the steer
  error path; `fenceTools` around every tool execute;
  `sink.setAuthorityCheck` at admission; delivery-time checks in the
  queued Telegram action path. A phase module either runs between two
  checks (pure/derived work) or receives the check as an injected
  `assertAuthority` (the `doCompact` shape). No module-level await may
  exist outside one of these two arrangements. Corollary (#115): an
  await is fenced on BOTH sides, success path included — a steer whose
  conversion succeeds must still re-compare the epoch before joining,
  replaying, or folding its content into the next request. Preserving
  the check *sites* through a refactor is not the same as proving the
  rule; every new await re-earns its post-await check.
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
  means the `queuedIds` filter is **admission's**, not the view
  builder's: the view module receives already-owned entries and cannot
  express "read what is merely durable", so the bug class cannot
  reappear as a view-layer convenience.
- **The sink contract.** Exactly one `onDone` per submit — completed,
  fenced, or error — including drops by `/stop` and the drain crash
  guard. `notifyDone`'s `doneSent` guard and `QueuedTurn` stay
  runtime-owned; every terminal path — the finish module, the fenced
  rail, the error rail — funnels through `notifyDone` once.
- **Streaming members and join replay** (design/app.md). Chunk fan-out
  to every streaming member at one emission point; a throwing sink is
  detached, never fatal; the wire log records exactly what the wire
  saw; a held failure (overflow) takes its error chunk and everything
  after it off the wire. **The claim-then-replay of streaming members
  is one mechanism with one home — the driver's membership seam** —
  used by both call sites (`prepareStep` steering and the overflow
  resume claim). **Ruling (#114): registration rides the same seam** —
  a claimed member enters the attempt's membership list at the splice,
  never when admission returns. The gap between claim and return is
  where a store read failure orphaned a joiner (claimed, untracked,
  stream hanging forever); with registration at the splice, every
  exception path — including drain's crash guard — settles it.

## Module map

`src/turn/` holds the phases; `runtime.ts` keeps the queue, the
attempt loop, and `checkAuthority`. Flat files, one job each, tests
colocated.

| Module | One job |
|---|---|
| `turn/state.ts` | `TurnState`: owns the attempt — the loop machinery (detector verdicts, watchdog ring/cadence/strikes, warn + cut text, context-landing decision) plus attempt-scoped state with narrow methods; `snapshot(): LoopTurnState` |
| `turn/admission.ts` | fix what this attempt owns, sees, and answers: settings capture, epoch, resume claim, ownership filter, anchor, mark seed, clock |
| `turn/view.ts` | pure model-view assembly: snapshot + recall + partial + step → byte-stable `ModelMessage[]`; single-message variant for steers |
| `turn/stream.ts` | drive one attempt's wire: streamText/toUIMessageStream wiring, `prepareStep` (steer fold + warnings + nudge), `onError`/`onStepEnd`, the chunk loop, fan-out, wire-log append, join replay, display deltas |
| `turn/overflow.ts` | turn a failed attempt into a resume decision or a terminal error: `ContextOverflowError`, `TurnRecovery`, classify, `hasContent`, `recoverFromOverflow`, give-up messages |
| `turn/finish.ts` | land a completed attempt durably: ownership-bounded anchor + retention source, defiance guard, persist + retention enqueue, window signal, reviewer snapshot |

Two turn-adjacent bodies live in existing modules, by surface:

- `recallMemory` lives in `memory.ts` (client, contexts, `noteRecall`
  are all memory's surface). The runtime calls it between authority
  checks.
- `retentionSourceFrom` + `RetentionSource` live in `memory.ts`, per
  the two-projections ruling below.

Stays in `runtime.ts`: the `Lane` map and queue (`submit`/`admit`/
`drain`/`claimableCount`), `stop`/`shutdown`/`cancelFenced`,
`compact`/`doCompact`, `checkAuthority`/`fenceTools`, `notifyDone`,
the attempt loop, and the `runTurn`/`runAttempt` orchestration that
calls the phases in order. The driver steers through a
runtime-injected function (queue policy — `claimableCount` — never
leaves runtime.ts) and persists through a runtime-injected append; no
`turn/` module sees a `Lane`.

The permanent e2e net lives in `runtime.test.ts` by the same rule:
authority, cross-turn cache behavior, channel and queue boundaries,
drain/stop/shutdown, and the overflow resume loop are cross-phase by
construction — phase modules carry their own colocated boundary tests.

## The two text projections (#84 / #111)

Known tension, ruled so a dedup sweep cannot unify it blindly:
compaction's serialization (`agent/compaction.ts` `messageText`)
embeds stored voice/video-note transcripts — durable operator speech,
#84 — and memory's retention projection (`memory.ts` `messageText`)
embeds them too: `design/memory.md` → Retain rules a stored transcript
is the text of the exchange, not attachment ingestion. The two jobs
still differ in what else rides: compaction folds **model-context
continuity** (losing a spoken instruction there degrades every future
turn), so bare attachment path references and bounded tool evidence
stay; retention builds **operator memory**, so transcript-less
attachments and raw tool output stay out.

The divergence lives as **two files, two design docs, one seam each.**
Compaction's projection stays in `agent/compaction.ts` (cited by
DESIGN.md → Compaction); the retention projection — `messageText`,
`buildRetentionDocument`, and `retentionSourceFrom` — consolidates in
`memory.ts` (cited by `design/memory.md` → Retain). `retentionSourceFrom`
sits in `memory.ts`, not in `turn/view.ts` or `turn/finish.ts`:
co-locating it with the model-view builder is how the projections would
silently fuse. The transcript mechanics may be shared between the two;
the content divergence above stays decided per file, and "which
projection am I in" remains answerable by file alone.

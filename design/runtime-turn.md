# The turn — architecture ruling

Core law is [`DESIGN.md`](../DESIGN.md); the turn's loop bounds are
`design/model.md` → "No step budget", the streaming contract is
`design/app.md` → "Streaming members & resumable streams". This file
rules `runTurn`'s decomposition: the phase cut, state ownership, the
attempt loop, and the turn journal's durable semantics.

Provenance: the W3.0 decomposition ruling (`runTurn` was one ~1,180-line
recursive function); law since 2026-10 — deviations come back here
first.

## Attempts and seam rulings

One **logical turn** = one enqueue-to-onDone unit of work; one
**attempt** = one pass of the model loop, and a logical turn has at most
two (overflow resume). The fenced and error rails are terminal — the
attempt loop's machinery, not phase modules.

Seam rulings that bind the phases:

- The resume claim must go through the stream driver's membership seam —
  claim + wire replay — via the same runtime-injected queue function the
  steer path uses; never splice `lane.pending`. (#96)
- Admission's ownership fix (ownership filter, anchor) is distinct from
  lane/controller pinning, which is runtime-owned, not admission's.
- Recall's surface belongs to `memory/mod.ts`; the runtime calls it
  between authority checks.

## State ownership, by lifetime

**State is classified by who survives it** — the rule that keeps
`TurnState` from becoming the giant function in an object costume.

1. **Conversation-scoped** — owned by the Runtime (or its `Lane`),
   survives turns, is never turn state, and reaches modules only as
   injected dependencies or callback seams.
2. **Recovery-carried** — exactly what `TurnRecovery` serializes: the
   exhaustive whitelist. Anything not on it dies with the attempt — a
   feature, since an in-flight verdict or a half-set display seam must
   not leak into the resumed attempt. Other deliberate deaths: restored
   warnings re-send once per attempt, an issued landing re-issues in the
   resume attempt, and the ownership mark re-derives instead of riding
   the recovery (the resume's fresh snapshot already contains the steered
   rows as durable history). The partial response is the one borderline —
   attempt output while the attempt lives, recovery payload on overflow —
   and riding the `ContextOverflowError` is correct.
3. **Attempt-scoped** — everything else: one `TurnState` object per
   attempt, mutated only through narrow methods — callbacks call
   methods, they never rebind locals.
4. **Not state** — the admission snapshot is immutable input to the
   attempt; everything derived from it per attempt is a value. Inputs
   and values get no setters and no methods.

## The attempt loop

The recursion is a returned decision consumed by a loop: `runTurn`
stays the logical-turn entry `drain` calls, creates the wire log once at
logical-turn scope, and hands it to each attempt.

- The recovery is the only wire between attempts — the loop adds no new
  state channel; membership rides the decision, never a shared
  reference.
- One recovery per logical turn is a property of the overflow classifier
  — a second overflow on the same admission is terminal — not of the
  loop, which is written unbounded so the invariant lives in exactly one
  place. No step budget: a turn's loops are caught, not capped
  (`design/model.md` → No step budget).
- The epoch is re-compared between compaction and the resume decision —
  before the recovery reaches the next admission.
- One logical turn, one loop history — unchanged (`design/model.md` →
  review-round rulings).

## The turn journal

`src/turn-journal.ts` is the crash journal. The run row lands before any
tool side effect can execute; a dispatched call without a result is the
ambiguous state — the side effect may or may not have happened. A
graceful shutdown fences its live rows first, so a row still running at
open means the process died mid-turn: open reclassifies it
`interrupted`, and boot sends one terse notice per run (counts by state,
never the partial itself). Nothing replays automatically — boot is
notice-only, and an `interrupted` turn resumes ONLY by explicit operator
decision into a FRESH admission (new epoch, not a continuation of the
dead attempt). Each attempt gets its own run row; the continuation's row
INHERITS the failed attempt's settled calls (as a fresh admission
inherits its source's), so a crash of the continuation still resumes
with every side effect the logical turn already recorded. Evidence
handoff is one transaction — successor creation, call inheritance,
source consumption — so no crash window exists where the successor
re-executes recorded effects. A fence-refused call journals as a
synthetic `replayed` result — proof of what the model saw, never a
second execution.

**Historical evidence is not automatic tool replay** (ruling
2026-10-19). A resumed/continued attempt builds a recovery guard once
from its inherited calls: a new tool invocation colliding with a
recorded EXECUTION (completed, failed, resolved-done, resolved-retry —
planned intent and synthetic replayed rows never count) gets a labeled
conflict naming the historical call ids, not the stale result and not a
silent re-run. Fresh-observation reads (`read_file`, `history_search`,
`memory_search`) execute afresh unless an explicit skip names them;
everything else is conservative. A `resolved-retry` grant is a FIFO of
source call ids, each consumed exactly once — the grant's
`retry_consumed` CAS flips inside the same transaction as the new
dispatch write, so a fault can never book an execution without spending
the grant, and a crashed-after-consume ambiguity stays owned by the new
dispatched row. Legacy rows migrate `retry_consumed = 1` — a
pre-migration grant is denied rather than guessed.

Stored `args` is a **preview**, never the identity: oversized JSON is
cut to a bounded total, so no consumer can ever receive an oversized
body, while the replay hash uses the FULL canonical input — truncation
never collides two calls or weakens a replay match. Resume refuses a
stored document that fails to decode (bad JSON or wrong shape) instead
of defaulting to something that bypasses its contract; the conversation
snapshot and loop state get the same tolerance — raw text kept, readable
refusal at resume.

Resume refuses on undecided dispatched calls (each needs an explicit
operator decision, never an automatic one), on drift from the run's
recorded model/thinking, and on a source that is not `interrupted`. The
resumed attempt's fence then refuses re-asked recorded executions with
a labeled conflict (the recorded output stays evidence in the seeded
partial, never the answer); planned calls, same-signature safe reads,
and calls holding an UNCONSUMED operator retry grant execute — the
grant is spent by the dispatch that runs under it; a skipped call's
re-ask gets the operator's decline, never the side effect. The model
sees only what the journal says happened. A headless resumed turn
notifies operators on terminal `onDone`.

**Operator resume is a new source-linked exchange, not a retroactive
attach** (ruling 2026-10-19). `/resume` admits a fresh attempt whose
input is a NEW durable user event — a provenance prefix plus the
original anchor's and the owned post-anchor inputs' parts verbatim,
but only for events the model view no longer carries — never the
original event re-appended. An event still in the view reaches the
model through its own entry; re-copying it would double the text in
the prompt and in the retention document. Visibility is measured at
ops-admission, so the lane must hold still for the measurement to
stay true: `Runtime.busy` counts queued and in-flight compactions as
busy, and a resume offered while the lane holds work refuses — a
queued or in-flight summary would otherwise rewrite the view between
measurement and the resumed turn's own admission, silently dropping
an anchor that read visible. The event rides the
admission anchor, so the recovered instruction survives compaction
and the reply anchors to the resume event itself; the prefix change
is tail-only. The seed also carries the original request's text for
the loop watchdog — the generated marker names provenance, not the
task, and the watchdog judges progress against the ask. Ownership is
journaled as durable event seqs — never
message ids, which are app-controlled and carry no uniqueness
guarantee: `owned_input_seqs` records the admitted user seqs plus
every successfully folded steer (one checkpoint write with the steer
mark, after conversion and the post-await authority check). Each
steer carries its own event seq on the queued member from the append
that persisted it — the fold records exactly that seq, never a scan
of the view matching message ids (two steers may share one id; only
the one that converted is owned), and admission's pending exclusion
is seq-based for the same reason. `resume_request_seqs` on the
interrupted source names the generated
events that are this run's own — the same store transaction as the
event append, which returns the real seq it wrote (never a
lastUserSeq inference), and whose registry UPDATE verifies it landed
— a partial or skipped write can never leave an unregistered event
reading as foreign. Stale-check reads the durable record
(`historyDetail`), never the compaction-filtered view, and refuses a
user event past the run's anchor that the run never owned — whether
it arrived mid-turn (a steer never folded) or after the
interruption; an anchorless run refuses any unowned input as such.
Only an event BOTH registered on the source AND carrying matching
`goblinResume` metadata is exempt — metadata alone is
client-controlled and never exempts, and a different event reusing
an owned or registered id stays foreign. A modern row whose
ownership omits its own anchor is inconsistent and refuses readable.
Legacy NULL ownership fails closed to anchor-only (anchorless runs
with no durable users stay resumable); a malformed column — either
`owned_input_seqs` or `resume_request_seqs` — is a readable refusal,
never a silent policy change.

## What must not change

Invariants a refactor can still break silently — the audit list for any
turn-structure change.

- **The authority rule** (DESIGN.md). `checkAuthority` around every
  await, `fenceTools` around every tool execute, epoch-compare guards in
  `prepareStep` and the steer error path, `sink.setAuthorityCheck` wired
  at admission, and delivery-time checks in the queued Telegram action
  path. A phase module either runs between two checks (pure/derived
  work) or takes the check as injected `assertAuthority`. No module-level
  await may exist outside one of these two arrangements. Corollary
  (#115): an await is
  fenced on BOTH sides, success path included — a steer whose conversion
  succeeds must still re-compare the epoch before joining, replaying, or
  folding its content into the next request. Preserving the check
  *sites* through a refactor is not the same as proving the rule; every
  new await re-earns its post-await check.
- **Cache stability** (DESIGN.md). Prompt assembly stays byte-stable:
  the view is a pure function of its inputs; steering appends tails
  only — prefix bytes untouched; the merge runs after per-message
  conversion; no clock, no per-turn variability. The sanctioned one-time
  rewrites (DESIGN.md → Cache stability) remain the complete list of
  legal hash moves.
- **Turn metadata separates billing from the window** (2026-10-19).
  `usage.input` is the whole loop's billed prompt sum — every step
  re-sent the full prompt; `usage.lastInput`/`lastCacheRead` are the
  final step's, the actual window occupancy (compaction math reads the
  same number). `promptChars` rides alongside: the final step's outbound
  prompt measured in serialized characters, split by `turn/itemize.ts`
  on the code-owned headings `prompt.ts` exports — the /context gauge
  scales those chars to `lastInput`, so its per-segment figures are
  estimates, exact in aggregate only. Serialization and tool-schema
  conversion failures are programming errors: itemization propagates
  them to the turn's error boundary rather than counting them as zero.
- **Admission semantics.** Snapshot-at-admission (a `/compact` landing
  mid-turn can't rewrite what the turn sees); recall is admission-time
  and never re-runs for steered input; the reply's anchor, retention
  source, and reviewer evidence read the exchange as ended, bounded by
  the ownership mark. The #82 ruling — durability is not ownership —
  means the `queuedIds` filter is **admission's**, not the view
  builder's: the view receives already-owned entries and cannot express
  "read what is merely durable", so the bug class cannot reappear as a
  view-layer convenience.
- **The sink contract.** Exactly one `onDone` per submit — completed,
  fenced, or error — including drops by `/stop` and the drain crash
  guard. `notifyDone`'s `doneSent` guard stays runtime-owned; every
  terminal path — finish, fenced rail, error rail — funnels through
  `notifyDone` once.
- **Streaming members and join replay** (design/app.md). Chunk fan-out
  to every streaming member at one emission point; a throwing sink is
  detached, never fatal; the wire log records exactly what the wire saw;
  a held failure (overflow) takes its error chunk and everything after
  it off the wire. Claim-then-replay has one home — the driver's
  membership seam — used by both call sites (steering and the overflow
  resume claim). **Ruling (#114): registration rides the same seam** — a claimed member
  enters the membership list at the splice, never when admission
  returns; the claim→return gap once orphaned a joiner (claimed,
  untracked, stream hanging forever), and with registration at the
  splice every exception path — including drain's crash guard — settles
  it.
- **Turn-module boundary.** No `turn/` module sees a `Lane`; steering
  rides a runtime-injected queue function and persistence a
  runtime-injected append — queue policy never leaves `runtime.ts`.

## The two text projections (#84 / #111)

Known tension, ruled so a dedup sweep cannot unify it blindly:
compaction's serialization (`agent/compaction.ts`) and memory's
retention projection (`memory/mod.ts`) both embed stored voice/video-note
transcripts — durable operator speech, #84 (`design/memory.md` →
Retain: a stored transcript is exchange text, not attachment
ingestion). They diverge on the rest: compaction folds **model-context
continuity** (losing a spoken instruction there degrades every future
turn), so bare attachment path references and bounded tool evidence
stay; retention builds **operator memory**, so transcript-less
attachments and raw tool output stay out. The divergence is **two files,
two design docs, one seam each**: compaction's stays in
`agent/compaction.ts` (cited by DESIGN.md → Compaction), retention's in
`memory/mod.ts` — not by the model-view builder in `turn/`, because
co-location is how the projections would silently fuse. Transcript
mechanics may be shared; the content divergence stays decided per file,
and "which projection am I in" remains answerable by file alone.

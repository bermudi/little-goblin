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

## Engine boundary

The agent loop's engine fork is named, not implicit: `src/turn/engine.ts`
holds the `TurnEngine` interface (`id`, `accepts`, `run`) and
`pickEngine`, which the runtime calls once per attempt — the first
engine whose `accepts(step)` is true wins; none fails the turn loud.
Every engine consumes the same deps object minus the step
(`EngineInput`) plus its own step variant, and returns the same
`StreamOutcome`. Engines today:

- `ai-sdk` — `src/turn/ai-sdk-engine.ts`, wrapping `turn/stream.ts`'s
  `driveStream` (streamText). Accepts every non-claude step.
- `claude-code` — `src/agent/claude-code/`; its `ClaudeEngine` handle
  also carries `compact`, the compaction seam's claude lane. Accepts
  `ClaudeStep` (`engine: "claude-code"`).

Ruling: `UIMessage` / `UIMessageChunk` stay goblin's storage and wire
format. The app channel is `useChat`; an engine translates at its own
edge, as the claude engine already does (`agent/claude-code/translate.ts`).
Both engines emit the identical wire, journal rows, and telemetry;
`src/turn/engine.conformance.test.ts` pins that per engine through the
real Runtime.

### Adding an engine

- Implement `TurnEngine` in its own adapter directory (one vendor
  package, one dir — the claude-code layout).
- Add the engine's step variant to `buildStep`'s union and gate it with
  `accepts`.
- Register it in `src/index.ts`'s `engines` array (first match wins).
- Add it to `src/turn/engine.conformance.test.ts`'s engine table.
- Add a `module-boundaries.test.ts` entry for its vendor packages.

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
the prompt and in the retention document. One exception: a skill
invocation's durable record is the reference alone — the body rides
only the owning turn's view — so references from ALL journal-owned
invocation messages are re-carried into the resume event for the new
run to own and inject, including pre-anchor coalesced inputs, not
merely the visible anchor; ordinary parts of a visible event stay
visibility-filtered, and the prefix names folded request/steering
only when those parts were actually copied. Visibility is measured at
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
is seq-based for the same reason. Every queued member's seq comes
from the append that persisted it (or the persisting caller's
registry) — never a `lastUserSeq` rediscovery — and the attempt owns
only the seqs its members carry: historical user entries stay in the
model view as context but are never owned, so an owning-turn-only
payload (a skill body) resolves for owned seqs alone (2026-10-21).
`resume_request_seqs` on the
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

`source_input_seq` is the durable handover identity: the newest owned
input's event seq, persisted at begin and at the same steer checkpoint
as `owned_input_seqs` so a folded steer genuinely moves who the turn
answers for (a still-queued input is never a member and never wins).
An operator-resume seed carries the source run's own journaled value —
the generated resume marker is never a source — and a legacy row
without it falls back to the max seq staleness validated (anchor or
latest owned input), except a legacy already-resumed row, which keeps
NULL: a handover on missing durable identity refuses rather than key
on a client message id.

## Unlanded-turn progress

**A turn whose reply never landed records its progress in history**
(ruling 2026-11-05; extended 2026-11-08 to fences and process death —
slice 1 of the 2026-10-31 reference review's F1, completed by #195).
Operator rule: if it happened, it is part of the session transcript.
Three rails append the same event shape — one `system` event carrying
the owning run id, the outcome, the journal's tool ledger, and the
assistant text checkpointed before the end. It is ordinary history, so
the next turn's view and compaction see it with no journal dependency in
the view. The operator sees it too.

- **The error rail** (2026-11-05): a terminal failure appends the event
  before the run's terminal stamp, with the failure message.
- **The fenced rail** (2026-11-08, #195): a graceful fence — `/stop`, a
  settings change, shutdown, deploy restart, a fence landing during
  overflow recovery — appends the same event labeled ended-aborted,
  before the `fenced` stamp. The write happens DESPITE the lost epoch:
  it is the sanctioned post-fence state write (the ⏹ superseded display
  stamp's precedent), recording what already ran, never continuing the
  turn. A shutdown names itself; a stop names the stop.
- **The interrupted rail** (2026-11-08, #195): process death. At journal
  open, each row reclassified `interrupted` gets its event appended
  INSIDE the reclassify transaction (one SQLite handle — the append
  joins it): the two commit atomically, a failure rolls both back and
  fails the open loud, and the next boot retries both — the record can
  be neither lost nor duplicated. Only rows newly reclassified at that
  open; historical interrupted rows keep their resume-only semantics.
  Resuming a run whose progress was recorded keeps the verbatim seed —
  the event is bounded evidence overlap, accepted (evidence, not
  instructions).

- **Outcome labels are the journal's, never upgraded.** A dispatched call
  with no recorded result renders as outcome unknown. The event is evidence,
  not proof of exactly-once execution, and it does not retire the journal,
  replay decisions, retry grants, or resume.
- **No duplicate.** Nothing is appended when the reply landed, when there is
  no progress to report, or — error rail only — when this attempt no longer
  holds authority. Attempts handed to a continuation (overflow, fallback)
  record nothing; the successor carries them. Journal faults (the journal
  cannot write, or the record is unreadable) attempt no event — the journal
  row remains the evidence.
- **Steps that ran are never replayed.** The event is a record, not a
  rerun: boot stays notice-only, resume keeps its recovery guard, and the
  event closes with exactly that instruction.
- **Anchored to the attempt's consumed input.** The event's `anchorSeq` is the
  latest input the attempt consumed (folded steers included, merely queued
  inputs never) — the value a completed reply would anchor to — so editing a
  later input does not remove it. The interrupted rail derives it from the
  row's owned seqs, falling back to the admission anchor on legacy rows.
- **An append failure doesn't change the outcome.** On the error and fenced
  rails it logs an error and the outcome still reaches the sinks; the
  interrupted rail is deliberately the loud exception — its append is
  transactional with the reclassify and fails the open.

## What must not change

Durable wake delivery (`wake-store.ts`, `wake-dispatcher.ts`) follows
the journal's ownership hooks, not submit callbacks. The hooks name
members by conversation + durable event seq — never by client message
id, which is untrusted and may repeat across events and lanes: a
foreign event reusing the trigger's id can neither link the wake to a
run that never processed it nor fail it closed. The link lookup
(`claimedForEvents`) matches claimed wakes on
`conversation_id + history_seq` for the same reason. Claiming a trigger
also records the conversation epoch: an unlinked claim may recover
after a crash only while that authority still matches. Legacy unlinked
claims without a recorded epoch fail closed. An overflow attempt's
`error/undelivered` stamp is not a terminal wake failure while its
message is still admitted under the same epoch — the admission check
is seq-scoped too; the successor's begin
hook transfers ownership. A stop, lost admission, or process death
ends that temporary hold. A terminal failure BEFORE the begin hook —
no run row exists, so reconcile would read the claimed wake as
unowned and re-admit the same trigger every pump — fires the
`preRunFailure` ownership hook (2026-10-22), and the dispatcher fails
matching unlinked claims closed (the same `failUnlinked` CAS a lost
ownership link uses). An overflow that WILL resume stays silent: its
successor links normally through its own begin.

Invariants a refactor can still break silently — the audit list for any
turn-structure change.

- **The authority rule** (DESIGN.md). `checkAuthority` around every
  await, `fenceTools` around every tool execute (new tool objects plus one `dispatch`
  that `script`'s nested calls share; it binds the input set's script tool, so fencing the same raw set twice throws), epoch-compare guards in
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
  conversion; no clock read at view time, no per-turn variability (arrival
  stamps are stored facts, DESIGN.md → Cache stability). The sanctioned one-time
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
  means the `pendingSeqs` filter is **admission's**, not the view
  builder's: the view receives historical context and admitted inputs,
  never still-pending inputs. Its separate owned-input seq set names
  only the current members, not every user entry in that context.
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
  runtime-injected append — queue policy never leaves `runtime.ts`. The
  tool fence (`turn/tool-fence.ts`) rides the same boundary: an injected
  authority check and journal, never the Runtime. So does the compaction
  job (`turn/compact-job.ts`): injected store, authority, fold ceiling,
  and lane-cancellation seams. And so does the run record
  (`turn/run-record.ts`), opened per attempt: the journal row's fault
  box, terminal stamp, and unlanded-progress recorder plus the attempt's
  model-fallback config, with the run id read through an injected
  getter — adoption itself stays a runtime statement after `beginRun`.
  Since #201 the same boundary carries the two seams `runAttempt` no
  longer inlines: **delivery** (`turn/delivery.ts` — the fenced
  voice/file/synthesis hooks, `TurnSink`/`TurnDone` at `turn/sink.ts`)
  and **tool authority** (`turn/tool-authority.ts` — run row before any
  tool side effect, ownership begin, recovery guard, fence; the
  `makeTools` contract is its `TurnToolMaker`). Since #195 (2026-11-08)
  that seam also owns step-end persistence: `saveStep` is the ONE home
  for the run row's step checkpoints — both engines route their
  step-end and steer-fold writes through it, never the journal
  directly, so a checkpoint fault classifies as a journal fault exactly
  like a fenced tool's write. The returned authority carries the run id
  and the ownership-begun fact as fields the runtime reads — no
  write-back callbacks into `runtime.ts`.

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

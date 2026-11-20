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
attempt loop's machinery, not phase modules. They live in
`src/runtime-rails.ts` (#791); `runAttempt` keeps the order that picks
one.

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
   methods, they never rebind locals. The facts the attempt reaches
   before it can throw — recall's result, the tool authority seam, the
   failed outcome's filter budget and held error — are one
   `AttemptProgress` on the attempt's scope (`runtime-rails.ts`), each
   field written by the phase where it becomes true. The rails read it;
   they capture no locals.
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
holds the neutral `TurnEngine` interface (`id`, `accepts`, `run`) and
`pickEngine`, which the runtime calls once per attempt — the first
engine whose `accepts(step)` is true wins; none fails the turn loud.
Every engine consumes the same deps object minus the step
(`EngineInput`) plus its own step variant, and returns the same
`StreamOutcome`. The AI SDK engine's `ModelStep` type lives in
`src/turn/ai-sdk-step.ts`, outside the neutral engine boundary. Engines today:

- `ai-sdk` — `src/turn/ai-sdk-engine.ts`, wrapping `turn/stream.ts`'s
  `driveStream` (streamText). Accepts steps tagged `engine: "ai-sdk"`.
- `claude-code` — `src/agent/claude-code/`; its `ClaudeEngine` handle
  also carries `compact`, the compaction seam's claude lane. Accepts
  `ClaudeStep` (`engine: "claude-code"`).

Ruling: `UIMessage` / `UIMessageChunk` stay goblin's storage and wire
format. The app channel is `useChat`; an engine translates at its own
edge, as the claude engine already does (`agent/claude-code/translate.ts`).
Model-facing prompts use Goblin's `PromptMessage[]` (`src/prompt-message.ts`);
the SDK shape is compared only in `src/prompt-message.test.ts`, and engines
convert at their own edge.
Both engines emit the identical wire, journal rows, and telemetry;
`src/turn/engine.conformance.test.ts` pins that per engine through the
real Runtime.

### Engine rules

Every engine follows these mandatory rules:

- Check authority after every vendor event and before the outcome.
- Run tools only through `deps.tools`, the fenced set.
- Never drop a claimed steer. Claim through `claimSteerBatch`; admit the batch
  (`admitSteers`) only once the model has it — the request itself on ai-sdk,
  the CLI's ack on claude-code. A batch the model never received goes back
  through `returnSteers` before the outcome: to the head of pending input while
  authority holds, settled `fenced` once it is lost. (#777)
- Call `saveStep` at every step end.
- Apply the fallback error hold through `holdsZeroEffectError`.
- Abort on `deps.signal`.
- Build reply metadata through `replyMetadata`.
- Return a `StreamOutcome`.

`EngineRules` declares the optional rules each engine follows:

| Rule | ai-sdk | claude-code |
| --- | --- | --- |
| `toolLaunchGate` | `true` | `false` — the CLI dispatches calls. |
| `preemptFold` | `true` | `false` — no pre-call boundary. |
| `contentFilterReask` | `true` | `false` — no per-call re-dispatch. |
| `transientRetry` | `true` | `false` — no per-call re-dispatch. |
| `contextFill` | `true` | `true` — each completed call reports usage. |

The runtime owns these rules, not the engines (#769):

- `toolLaunchGate`: the runtime arms the tool fence's steer gate from
  the declaration.
- The other four live in `src/turn/step-rules.ts`. The runtime opens
  one `StepRules` per attempt and passes it as `deps.rules`. It holds
  the policy, the budgets and the log lines.
- An engine only reports its model-call boundaries:
  - `beforeCall` — before a call dispatches. An arm returned means
    stop with a `PreemptSignal`.
  - `afterCall` — a call ended. Every engine calls it.
  - `callFailed` — a call failed. `true` means re-dispatch the same
    call.
- A rule is `true` exactly when the engine's vendor loop can reach that
  hook.

`src/turn/engine-rules.test.ts` checks each declaration. It drives each
rule through the real Runtime for each production engine. It fails when
an engine claims a rule it does not follow, and when it follows a rule
it does not claim.

### Adding an engine

- Implement `TurnEngine` in its own adapter directory (one vendor
  package, one dir — the claude-code layout).
- Call the `deps.rules` hooks its vendor loop can reach, and declare
  its `rules` to match.
- Add the engine's step variant, with its own `engine` tag, to `TurnStep`
  in `src/runtime.ts`; its `accepts` checks that tag.
- Register it in `src/index.ts`'s `engines` array (first match wins).
- Add it to `src/turn/engine.conformance.test.ts`'s engine table and
  give it a probe in `src/turn/engine-rules.test.ts`.
- Add a `module-boundaries.test.ts` entry for its vendor packages.

## The turn journal

`src/turn-journal.ts` is the crash journal. The run row lands before any
tool side effect can execute; a dispatched call without a result is the
ambiguous state — the side effect may or may not have happened. For the
journal a graceful shutdown IS a crash (#471): a shutdown-fenced turn
leaves its row `running` and records nothing — the next open
reclassifies it `interrupted` exactly like process death (openclaw
drains active turns and re-dispatches them,
`docs/gateway/restart-recovery.md`; hermes marks sessions
`resume_pending` and auto-continues, `gateway-session-lifecycle.md` —
borrowed as mechanism only: a restart must not silently strand an
unanswered request). `fenced` is now
operator/epoch fences only — `/stop`, settings changes, deploy-era
authority loss outside shutdown. Boot sends one terse notice per run
(counts by state,
never the partial itself). The notice is a durable debt, not an
open-time snapshot (#579, ruling 2026-11-15): open consumes its crash
windows into `boot_notices` rows — interrupted rows inside the
reclassify transaction, stranded counts with the `journal_opens` row —
and a row claims only after a Telegram send lands (any one operator).
A boot that dies before the attach, or whose every send fails, hands
the row to the next boot instead of dropping it; a send that landed
with a claim that could not commit re-sends at-least-once. Because a
row can outlive its advice, the sender drops and claims without
sending when the run left `interrupted` (a legacy `resumed`/`abandoned`
stamp) or its
landed reply was already re-delivered (#482). Nothing replays
automatically — boot is
notice-only, and there is no operator resume at all (ruling
2026-11-16, #594): a turn killed by process death leaves only its
history record — the interrupted rail's system event — plus the boot
notice, and the operator continues by sending a new message, which
starts an ordinary fresh turn. Each attempt gets its own run row; a
continuation's row (overflow, fallback) INHERITS the failed attempt's
settled calls (as a fresh admission
inherits its source's), so a crash of the continuation still records
every side effect the logical turn already ran. Evidence
handoff is one transaction — successor creation, call inheritance,
source consumption — so no crash window exists where the successor
re-executes recorded effects. A fence-refused call journals as a
synthetic `replayed` result — proof of what the model saw, never a
second execution.

**Ruling 2026-11-16 (#594): pi's behavior — no operator resume.** A
killed turn is history, not a work item. pi persists messages as they
land (`pi-mono/packages/coding-agent/src/core/agent-session.ts`,
message-granular persistence) and its request transform answers a
missing tool result rather than replaying the call
(`pi-mono/packages/ai/src/api/transform-messages.ts`); goblin's
equivalent record is the interrupted rail's system event — written
inside the reclassify transaction at journal open — which the next
turn's model view carries as evidence, closing with "steps that ran
are never replayed". The deleted machinery — the app's interrupted-run
card and routes, `/resume`, `/decide`, `/abandon`, per-call
record/retry/skip decisions, resume seeds, `resume_request_seqs`,
retry grants — has no replacement. Legacy rows decode and stay inert;
columns written before the change (`resumed_from`,
`resume_request_seqs`, `retry_consumed`, `resolution_note`,
`resolved_ms`, `origin_run`, `replayed`) remain for reads only.
Internal continuation — the overflow fold-resume and fallback — is
unchanged; "resume" there names the technical continuation, never an
operator action.

**Historical evidence is not automatic tool replay** (ruling
2026-10-19; grants removed 2026-11-16, #594). A continued attempt
builds a recovery guard once
from its inherited calls: a new tool invocation colliding with a
recorded EXECUTION (completed, failed, and the legacy `resolved-done`/
`resolved-retry` states — planned intent and synthetic replayed rows
never count) gets a labeled
conflict naming the historical call ids, not the stale result and not a
silent re-run. Fresh-observation reads (`read_file`, `history_search`,
`memory_search`) execute afresh; a legacy `resolved-skip` still refuses
the re-ask with the operator's recorded decline, and everything else is
conservative. The pre-#594 `resolved-retry` grant is gone with its
writer: a legacy grant row now reads as one more recorded execution —
a conflict, never a permit — and `retry_consumed` is write-dead (legacy
rows keep `retry_consumed = 1`: a pre-migration grant is denied rather
than guessed).

Stored `args` is a **preview**, never the identity: oversized JSON is
cut to a bounded total, so no consumer can ever receive an oversized
body, while the replay hash uses the FULL canonical input — truncation
never collides two calls or weakens a replay match. A stored document
that fails to decode (bad JSON or wrong shape) fails loud at the
boundary instead of defaulting to something that bypasses its
contract; the conversation snapshot and loop state get the same
tolerance — raw text kept, readable refusal.

**Owned input is journaled as durable event seqs** — never
message ids, which are app-controlled and carry no uniqueness
guarantee: `owned_input_seqs` records the admitted user seqs plus
every successfully folded steer (one checkpoint write with the steer
mark, after conversion and the post-await authority check). On claude-code,
that write happens at the CLI's ack (#777). Each
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
The interrupted rail's anchor and the stranded-input count read the
same record. `resume_request_seqs` and the `goblinResume` metadata
marker survive as legacy decode only — nothing writes them post-#594;
the stranded count still excludes marker-carrying rows it finds.

`source_input_seq` is the durable handover identity: the newest owned
input's event seq, persisted at begin and at the same steer checkpoint
as `owned_input_seqs` so a folded steer genuinely moves who the turn
answers for (a still-queued input is never a member and never wins). A
continuation carries the predecessor's journaled value, and a legacy
row without it falls back to the max seq the admission anchored on; a
handover on missing durable identity refuses rather than key on a
client message id.

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
- **The fenced rail** (2026-11-08, #195; narrowed 2026-11-13, #471): an
  operator/epoch fence — `/stop`, a
  settings change, a fence landing during
  overflow recovery — appends the same event labeled ended-aborted,
  before the `fenced` stamp. The write happens DESPITE the lost epoch:
  it is the sanctioned post-fence state write (the ⏹ superseded display
  stamp's precedent), recording what already ran, never continuing the
  turn. A shutdown fence no longer rides this rail: it leaves the row
  `running` and appends nothing, so the next open's interrupted rail
  owns both the stamp and the record.
- **The interrupted rail** (2026-11-08, #195): process death — kill,
  crash, or a graceful shutdown mid-turn (#471). At journal
  open, each row reclassified `interrupted` gets its event appended
  INSIDE the reclassify transaction (one SQLite handle — the append
  joins it): the two commit atomically, a failure rolls both back and
  fails the open loud, and the next boot retries both — the record can
  be neither lost nor duplicated. Only rows newly reclassified at that
  open; historical interrupted rows stay inert (#594 — nothing resumes
  them).

- **One record, and it is the reply the operator watched** (ruling
  2026-11-09, #408; start-only identity 2026-11-10). On the error and
  fenced rails the event takes the id of the assistant message the wire
  streamed and carries that reply's parts in
  `metadata.unlanded.reply`, rebuilt from the turn's wire log
  (`replyFromWire`). The wire's `start` chunk alone is enough: a turn
  stopped or failed before its first content part still opened an
  assistant message, and keeping its id — with whatever parts arrived,
  possibly none — is what lets the app replace the empty optimistic
  card it showed. When no `start` ever reached the wire the event
  mints a fresh id and carries no reply: a plain system record with
  nothing to reconcile. The app reconciles its local partial with the
  event by id and draws the reply marked Stopped or Failed, the
  model-facing text folded under it — one thing on screen, the same
  after a reload. Before this the streamed partial lived only in the
  browser beside a random-id event: shown twice, then lost on reload.
  The model view is untouched: it reads the event's text only, never
  the metadata, so the stopped reply is display, not replayed assistant
  output (pi's rule —
  `pi-mono/packages/ai/src/api/transform-messages.ts` skips errored and
  aborted assistant messages on replay). The body's assistant text comes
  from the streamed reply when it has text (it includes the unfinished
  step), else from the journal checkpoint. The interrupted rail has no
  wire log, so its event carries no reply and keeps a fresh id.
- **`stop().active` is the wait-for-the-record seam.** It resolves when
  the turn running at the call has left `runTurn` — record in history,
  sinks notified — and never follows a turn submitted later. The app's
  Stop route waits on it (bounded, 5 s) so the client's refresh after
  Stop finds the record. `settled` keeps its meaning (dropped queued
  sinks only).
- **Outcome labels are the journal's, never upgraded.** A dispatched call
  with no recorded result renders as outcome unknown. The event is evidence,
  not proof of exactly-once execution, and it does not retire the journal
  or the continuation recovery guard.
- **No duplicate.** Nothing is appended when the reply landed, when the
  interrupted rail has no progress to report (no call, no text, and no
  wire reply — process death before any output stays silent, as
  before), or — error rail only — when this attempt no longer holds
  authority. Once a run row exists, the error and fenced rails record a
  live turn's outcome even with nothing else to show: a stop or failure before the
  first content part still lands exactly one event — the outcome itself
  is the evidence the next turn needs. Attempts handed to a
  continuation (overflow, fallback) record nothing; the successor
  carries them. Journal faults (the journal cannot write, or the record
  is unreadable) attempt no event — the journal row remains the
  evidence.
- **Steps that ran are never replayed.** The event is a record, not a
  rerun: boot stays notice-only, no operator resume exists (#594), and
  the event closes with exactly that instruction.
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

The wake pump starts only after `runtime.mount()` installs the completed tool
factory and wake-ownership hooks.

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
  runtime-injected append — queue policy never leaves the runtime's lane
  modules (`runtime.ts`, `runtime-lanes.ts`). The
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
  `makeTools` contract is its `TurnToolMaker`). Since #477 the fence
  also carries the steer gate: a runtime-injected claimable-pending
  read — armed only for an engine whose model-call boundary claims
  steers — skips an unlaunched call with a synthetic replayed result
  when input waits; the claim itself still belongs to `prepareStep`.
  Since #195 (2026-11-08)
  that seam also owns step-end persistence: `saveStep` is the ONE home
  for the run row's step checkpoints — both engines route their
  step-end and steer-fold writes through it, never the journal
  directly, so a checkpoint fault classifies as a journal fault exactly
  like a fenced tool's write. The returned authority carries the run id
  and the ownership-begun fact as fields the runtime reads — no
  write-back callbacks into `runtime.ts`.
- **The lane registry is its own module** (2026-11-12, #436):
  `src/runtime-lanes.ts` owns the per-conversation lane map — pending
  turns, queued compactions, the controller and live-wire slots, the
  admission index — behind a narrow synchronous registry API
  (`enqueue`, `claim`, `unrequeue`, `registerController`,
  `registerLive`, `pendingFloor`); `runtime.ts` keeps the policy the
  registry serves: intake admission, the drain loop, the attempt
  loop, cancellation. `Lane` is private to the registry, so the
  boundary rule above is now structural — no `turn/` module can see a
  `Lane` or touch queue policy; steering still rides a
  runtime-injected queue function, persistence a runtime-injected
  append.
- **The terminal rails are their own module** (2026-11-20, #791):
  `src/runtime-rails.ts` holds the four rails a throwing attempt takes —
  journal fault, fence, overflow recovery, error with the model
  fallback walk. `runAttempt` picks one in that order; the order is
  load-bearing. A rail reads only the named `AttemptScope` (members,
  admission snapshot, run record, progress, and injected `notifyAll`,
  `compact`, authority and shutdown reads). It sees no Runtime and no
  lane, and must not import `runtime.ts`. The rest of the attempt stays
  in `runtime.ts` as phases with named inputs: `openAttempt`
  (admission and the scope), `runAdmitted` (the phase order),
  `openSeams`, `buildView`, `runEngine`, `landReply`, `afterLanding`.

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

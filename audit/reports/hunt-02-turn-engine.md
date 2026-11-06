> Audited 2026-10-23 16:27 local, at repo commit `59d3f7d7` (tracked tree clean; only untracked audit/ notes). Production files are identical at `9d4f861e`, the HEAD this audit closed on — its sole change is app/src/WindowView.test.tsx.

# Hunt 02 — turn engine (runtime, conversation, turn/, journal, resume, loop, rolling)

Scope per brief: `src/runtime.ts`, `src/conversation.ts`, `src/turn/` (admission,
finish, itemize, overflow, retry-guard, skill-attribution, skill-view*, state,
stream, view), `src/turn-journal.ts`, `src/turn-resume.ts`, `src/loop-detect.ts`,
`src/loop-watchdog.ts`, `src/rolling.ts`, plus colocated tests. Read-and-report
only; no fixes, no commits, no installs, no live services.

*`skill-view.ts` does not exist — `src/turn/skill-view.test.ts` tests
`src/turn/view.ts` (see Smells S1).*

Baseline: `bun test src/runtime.test.ts src/conversation.test.ts src/turn/
src/turn-journal.test.ts src/turn-journal.crash.test.ts src/turn-resume.test.ts
src/loop-detect.test.ts src/rolling.test.ts` → **456 pass, 0 fail** (17 files,
2503 expects). `bun run typecheck` → clean (both tsc programs). Guardrail scan:
no `console.*`, no `any` in scoped sources.

Scratch repro for F1: `/tmp/goblin-hunts/hunt02-journal-id-reuse.ts` (imports
the repo's `turn-journal.ts` against an in-memory DB; no repo writes).

---

## 1. Findings (most severe first)

### F1 — P1 — A tool-call id reused across an inherited journal span silently drops the new execution's records; the operator retry-grant path hard-fails the turn

**Where:** `src/turn-journal.ts:494-523` (`qInput`/`qDispatch`/`qResult`/
`qError` upsert guards), inheritance at `src/turn-journal.ts:574-581` +
`beginRun` transaction `:601-629`; consuming seam `src/runtime.ts:656-707`
(`fenceTools`/`note`); precedent for per-request id synthesis documented in the
tree at `src/turn/stream.ts:614-615`.

**Rule violated:** `design/runtime-turn.md` → "The turn journal": "The run row
lands **before any tool side effect can execute**; a dispatched call without a
result is the ambiguous state — the side effect may or may not have happened."
Reinforced by the fence's own contract comment (`src/runtime.ts:641-645`): "the
row is the only record of what ran — letting the SDK surface an ordinary tool
failure invites the model to repeat a side effect the journal can no longer
describe."

**Mechanism (verified by scratch repro):** each attempt gets a fresh run row,
and a continuation *inherits* the predecessor's settled call rows **into its own
`run_id`** (`INSERT OR IGNORE ... SELECT`), so the primary key
`(run_id, tool_call_id)` spans both the inherited calls and the new attempt's
own calls. Every write is an upsert whose `DO UPDATE ... WHERE` clause accepts
only forward transitions (`name = ''`, `state IN ('planned','dispatched')`).
An inherited row is already terminal, so when the provider **reuses a tool-call
id across responses** — exactly the class of behavior the tree already
documents for part ids ("openai-compatible providers synthesize part ids per
request, so step 2 can reuse step 1's id verbatim", `stream.ts:614`) — the new
attempt's `noteToolInput`, `noteToolDispatch`, and `noteToolResult` for that id
are all **silent no-ops** (bun `query.run` does not throw when the ON CONFLICT
WHERE excludes the row; `journalFault` only arms on a throw). The tool then
executes (fenceTools proceeds after a non-throwing dispatch write) with **no
journal record at all**; a subsequent crash leaves the row 'completed' carrying
the *predecessor's* args and result — worse than the ambiguous state the
journal exists to prevent.

Worse on the grant path: an operator-authorized retry whose re-ask lands under
a colliding id reaches `noteToolDispatch(..., {retryCallId})`, whose target
check (`turn-journal.ts:647-650`) reads the inherited row — state
`'resolved-retry'`, not `'planned'` — and **throws** `"retry dispatch … is
already 'resolved-retry'"`. In `fenceTools` that throw lands in `note()` →
`journalFault` → the runtime aborts the whole turn as an error
(`runtime.ts:1292-1309`). An explicit operator decision kills the turn.

**Repro output** (`bun /tmp/goblin-hunts/hunt02-journal-id-reuse.ts`; run A
completes `call_0` with args `{n:1}`, run B inherits A, then journals a fresh
`call_0` execution with args `{n:2}`, result `{fresh:true}`):

```
B rows: [{ id: "call_0", state: "completed", args: { n: 1 },
           result: "{\"old\":true}", hash: "2bfd14f4" }]
retry dispatch THREW: retry dispatch call_0 on run B is already 'resolved-retry'
```

The new execution is nowhere in run B's rows; the row still shows A's evidence.

**Triggering path:** any continuation attempt whose model response contains a
tool call whose id equals an inherited call's id — always true on providers
that number tool calls per response (`call_0`, `call_1`, … restarting each
response; llama.cpp-style openai-compatible servers). Two reachable shapes:
(a) overflow recovery — the continuation `inheritFrom` the failed attempt
(`runtime.ts:1091`) and the resumed response re-numbers from `call_0`;
(b) operator `/resume` — the successor inherits the interrupted source
(`turn-journal.ts:615-619`). Server-side id providers (z.ai, Anthropic) do not
trigger it.

**Test sketch:** open a journal; `beginRun A`; journal input/dispatch/result
for `call_0`; `beginRun B` with `inheritFrom: ["A"]`; then
`noteToolInput(B,"call_0",…)` + `noteToolDispatch(B,"call_0",…)` +
`noteToolResult(B,"call_0",…)` with different args; assert either a second
representable row or a loud throw — today the writes vanish silently. For the
grant path: mark the inherited row `resolved-retry`/unconsumed, dispatch under
the same id with `retryCallId` — today it throws and, via `fenceTools`, kills
the turn.

**Fix direction (for the owner, not applied):** namespace inherited ids at
inheritance time (rewrite `tool_call_id` to `pred:<id>` on copy — they are
evidence rows, never re-dispatched) or detect a non-advancing upsert at the
dispatch seam and treat it as a journal fault. The synthetic `replayed` refusal
path would also need the same treatment.

---

### F2 — P2 — Schema-rejected tool calls are invisible to the loop detector and the watchdog; a model re-submitting identical invalid args loops uncaught until the context window fills

**Where:** `src/turn/stream.ts:652-661` (`tool-input-error` case only logs and
records `callById`), `noteCompletedCall` invoked solely from
`tool-output-available` (`:713`) and `tool-output-error` (`:730`);
`src/turn/state.ts:100-161` (`noteCompletedCall` feeds both
`LoopDetector.record` and the watchdog ring).

**Rule violated:** `design/runtime-turn.md` → "The attempt loop": "No step
budget: a turn's loops are caught, not capped (`design/model.md` → No step
budget)." A repeated identical rejection is a loop that is caught by nothing
deterministic.

**Mechanism (verified in the SDK bundle):** an invalid tool input maps to a
`tool-input-error` chunk only (`node_modules/ai/dist/index.js:7406-7418`,
`tool-call` part with `invalid`); no `tool-result`/`tool-error` part follows
(`:7438-7453` requires an execution), so `noteCompletedCall` never fires for a
rejected call. The detector (`loop-detect.ts:58-76`) and the watchdog ring
(`state.ts:118-127`) only see calls that produced an output chunk. The comment
at `stream.ts:653` ("record name+input here or the detector hashes each
rejection under a random call id and never trips") describes healing for a
later output-error chunk — which never comes for an input rejection — and
reads as if rejections are detected; they are not. The only backstop is the
85%-of-window context landing (`state.ts:66-69`), i.e. the loop is capped by
the window after potentially dozens of billed steps.

**Triggering path:** a tool whose schema the model cannot satisfy (the Sep 28
outage class the test itself cites — provider emits `{}` for a required-arg
tool) plus a model that retries the same invalid args instead of giving up.
Each rejection returns error text to the model and the turn continues.

**Test sketch:** scripted model that emits N identical invalid `read_file`
calls; assert the repeat detector warns at 10 and cuts at 20 as it does for
completed calls (`runtime.test.ts:2836` is the completed-call twin). Today: no
warn, no cut.

---

### F3 — P3 — `runtime.stop()` throws when the conversation row is gone instead of a quiet noop

**Where:** `src/runtime.ts:463-466` → `store.bumpEpoch` →
`src/conversation.ts:1232-1237` (`bump` throws `conversation ${id} not found`
after a 0-row UPDATE).

**Rule tension:** `DESIGN.md` → "The authority rule" / Domain model: "`/stop`
fences the running turn and drops queued ones" — a stop that finds nothing to
stop is a noop everywhere else (`cancelFenced` logs "nothing was running" at
debug, `runtime.ts:507`). The missing-row case instead throws to the command
caller. In practice the delete flow fences first by convention
(`conversation.ts` `deleteConversation` doc: "A live turn must be fenced first
(runtime.stop)"), so the throw only surfaces in a convention-violating race.
P3 edge/error-path hygiene.

---

## 2. Checked and found clean (later passes can skip)

- **Authority rule, exhaustively.** Every `await` in `runAttempt` has its
  post-await check (recall `runtime.ts:1030-1037`, buildStep `:1126-1132`,
  driveStream contract `stream.ts:597/754/785`, land path sync from the last
  check to the append through `notifyAll` → `:1245`, threshold compaction via
  injected `assertAuthority`); `doCompact` checks after the contextWindow await
  and registers `compactController` before it (`:540-552`); `fenceTools`
  re-checks per tool execute and journals dispatch only after the check;
  prepareStep steer fold is fenced on both sides of `convertSteeredMessage`
  (#115, `stream.ts:374-397`, tested at `runtime.test.ts:2554`); the
  `!holdsAuthority` unrequeue path (`stream.ts:361-363`) is unreachable across
  an `/stop` interleave (cancelFenced's pending splice precedes any claim) and
  correct for a settings-only epoch bump.
- **Epoch bump rules.** `stop` and `applySettings` bump
  (`conversation.ts:1501-1506`); `initializeAppSettings` /
  `captureConversationSettings` — the model/thinking path — write without a
  bump ("no epoch fence", `:1204-1230`); overflow resume keeps the admitted
  `conversation` in the recovery (`overflow.ts:149`, `admission.ts:70`),
  tested at `runtime.test.ts:3072` and `:3152`. Non-test `applySettings`
  callers pass only voice/memory/persona patches (`tg/commands.ts:107`,
  `http/app-conversations.ts:533`, `projects.ts:302`).
- **Journal crash classification.** `running` → `interrupted` reclassification
  + one-time `interruptedAtOpen` snapshot (`turn-journal.ts:468-481,573`),
  graceful fences stamp `fenced` before exit; terminal states never regress
  (upsert WHERE clauses, tested `turn-journal.test.ts:77,117,169`).
- **Resume rides journaled rows only.** Everything in the seed comes from
  journal rows (`turn-resume.ts:586-701`); staleness is seq-based over
  `historyDetail` (never the compaction-filtered view), registry+append is one
  transaction with a zero-row guard (`turn-journal.ts:708-741`,
  `runtime.ts:350-367`), grants are a FIFO with a CAS consumed in the dispatch
  transaction, safe reads execute afresh, everything else conflicts, legacy
  NULL fails closed, malformed columns refuse readable — all verified in code
  and pinned by ~40 tests in `turn-resume.test.ts`.
- **Overflow recovery.** One-recovery budget lives in `overflowHoldable`
  (second overflow terminal, tested); partial/toolCalls/digest/loop/
  filterRetryUsed/recallVersion carried; the recovery claim goes through the
  membership seam (`admission.ts:79` → `claimMembers`, #96/#114 — registration
  at the splice, crash-guard settles claimed joiners, `runtime.test.ts:1473`).
- **Steered input is never re-recalled** — recall is admission-time only; the
  fold path is `convertSteeredMessage` (no memory call anywhere in
  `turn/stream.ts`).
- **Rolling DM.** `dm:<chat>` never pins a concrete row: routing reads
  `currentDm` (the `dm_rolls` pointer) before and after every gate await,
  rolls land in one transaction, `/back` walks strictly decreasing ordinals
  with chat-coordination checks, deleted currents tombstone the ordinal
  high-water, and a recreated id restarts above the epoch high-water
  (`conversation.ts:1118-1360,1664-1721`; `rolling.ts` throughout; tested in
  both suites).
- **Loop detector false positives.** Key order canonicalized
  (`stableStringify`), identical-args-with-changing-results never trips,
  repeats beyond the 40-call window never trip, A/B alternation counts per
  side deliberately (`loop-detect.test.ts`).
- **Unserialized queue access.** All `lane.pending` mutations are synchronous
  (`admit` push, `claimPending` splice, `unrequeueSteers` unshift) with no
  `await` spanning a mutation pair; drain's empty→return exit is one sync
  block, so an admit either lands before the final claim (picked up) or after
  `running=false` (starts a new drain). No interleave exists.
- **The compaction summary cannot displace the turn anchor.** Traced end to
  end: `chooseBoundary`'s tail always contains the newest events, so the
  triggering request always rides the tail above the boundary; `steerMark`
  (seeded from the admission view's max seq) is ≥ the request seq, so
  `finish.ts:74-83`'s anchor loop always selects the real request over the
  summary's borrowed boundary seq. The exclusion in `turn-resume.ts:604-608`
  serves a different set-membership purpose there.
- **Exactly one `onDone` per submit** — `notifyDone`'s doneSent guard covers
  `/stop` drops, the drain crash guard, duplicate `notifyAll` after a
  post-delivery fence, and settle-once for steers.
- **conversation.ts store:** envelope versioning + one-time bare-row
  migration, corrupt rows degrade to placeholders and never fail a turn, FTS
  triggers/backfill (including the migration UPDATE re-indexing), causal sort
  and compaction cut on `(anchorSeq ?? seq)`, projections overlay the model
  view only, epoch high-water across delete/recreate, forkToApp's verbatim
  copy with marker retargeting — all read and covered by
  `conversation.test.ts`.
- **itemize/view/state/admission/finish/overflow/retry-guard** units read line
  by line against their tests; nothing beyond F2's rejection gap.

---

## 3. Could not verify

- **Which configured providers actually reuse tool-call ids across responses**
  (F1's trigger). The mechanism is proven against the journal; the id-synthesis
  behavior of specific providers would need live probing, which the rules of
  engagement forbid. Labeled: verified mechanism, provider-dependent trigger.
  The tree's own per-request-part-id precedent (`stream.ts:614`) is the
  strongest available evidence the class exists in production paths.
- **AI SDK behavior when `onError` throws** (`stream.ts:446`
  `deps.assertAuthority()` inside the callback). Every downstream shape I
  traced fails safe (the terminal error chunk still reaches the chunk loop,
  whose assert fences), but I did not trace the SDK's callback error handling
  in the bundle; no test pins a throw inside `onError` specifically.
- **Out-of-scope consumers** (telegram delivery, prompt assembly, HTTP stream
  surface, subagent lanes, wake dispatch) were noted as pointers only per the
  brief; the runtime-side ownership hooks (`begin`/`members`/`end`/
  `preRunFailure`) were checked for call-site correctness only.

---

## 4. Simplifications & code smells (operator-requested section; P3-level, evidence-backed)

- **S1 — Misleading name: `src/turn/skill-view.test.ts` tests `view.ts`.**
  The source module was folded into `view.ts` (skill-part rendering lives at
  `view.ts:87-126`); the test file kept its old name, and the hunt brief
  itself lists a `skill-view` module that does not exist. Rename to
  `skill-view`-under-`view.test.ts` coverage or fold the file into
  `view.test.ts`.
- **S2 — Duplicated schema: `scriptOutputSchema` (`stream.ts:46-55`) vs
  `scriptCallsSchema` (`skill-attribution.ts:13-17`).** Byte-identical shapes
  (`calls: [{tool, args, ok, result}]`) parsed independently at
  `stream.ts:672` and `skill-attribution.ts:52`; a nested-call format change
  must be edited twice or the digest and the provenance scan silently diverge.
- **S3 — Dead production API: `ConversationStore.lastUserSeq`
  (`conversation.ts:331`, impl `:1568`).** No non-test consumer exists in
  `src/` or `app/` (grep: only `*.test.ts` and `test-helpers/`). The interface
  doc ("a turn's response anchors to it") describes the pre-seq-handoff design;
  responses now anchor via admission/steerMark seqs captured from the append.
- **S4 — Redundant re-truncation in `decodeCall` (`turn-journal.ts:370`).**
  `args: tryParseJson(boundedArgsText(r.args))` re-applies the bound to a
  column that was bounded at write time (`noteToolInput`/`noteToolDispatch`
  both pass `boundedArgsText(canonical)`); the read-side call can never change
  the value. Drop the wrapper or assert the invariant.
- **S5 — `writeOutputSchema.passthrough()` vs its script twin's strictness
  (`skill-attribution.ts:11` vs `:13-17`).** The file-parse schema and the
  script-call schema enforce different strictness for the same "tool output
  envelope" family in one 62-line module; harmless today, but the asymmetry
  has no stated reason and invites a copy-paste of the wrong one.

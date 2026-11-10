# Compaction — architecture ruling

Core law is [`DESIGN.md`](../DESIGN.md); the summary's live contract is
`design/model.md` → "Compaction". This file rules what a fold keeps, when it
fires, what the summary must contain, and where the app shows it.

Provenance: operator session 2026-11-09. Goblin's compaction was compared
against pi (`~/build/pi-mono`), OpenClaw (`~/build/testing/openclaw`) and
Hermes (`~/build/testing/hermes-agent`). The two mature agents are built for
long chat sessions and have large user bases filing issues; most of goblin's
earlier deviations from pi were reasoning without measurement. The ruling:

- **Base: OpenClaw** (itself built on pi) — tail size, split turns, the
  summary quality audit, the pre-fold memory flush, overflow recovery.
- **Early fold: Hermes** — compact at a fraction of the window with an
  absolute cap, so a 1M window never carries 750k tokens into a summary or
  into every call's bill.
- **Continuity: Hermes lean mode** — the parts made by code, not by the
  model: a regex identifier index, verbatim user messages, a recovery
  pointer. Hermes measured them on real 500k-token sessions (~49k kept vs
  ~162k, better recall; `evals/compaction/results/` in its tree).

**Rule for any future deviation:** pi/OpenClaw/Hermes behavior is the
default. A goblin difference must name a goblin-only constraint or a measured
result, in this file. "It seemed better" is not a reason.

**Status:** Staging 1's trigger and 20k tail are built (#399); its
split-turn cut is not (#403). Stage 3's fold marks are built (#401);
stage 2's headings, audit, identifier index and verbatim user messages are
built (#400, `src/agent/compaction-summary.ts`); its memory flush is not
(#405). Superseded and removed
from this file: the ledger/atlas/narrative method, the understudy, and the
known-missing manifest — the audit and lean parts below cover the same
ground with evidence behind them. Git history has the old text.

## Triggers

A fold fires at the **lower** of:

- **50%** of the catalog window (Hermes's default ratio), and
- **128,000 tokens** absolute (Hermes caps at 256k for quality; goblin
  caps lower for cost: every call re-sends the whole context, so a fold
  bounds the per-call input bill on expensive models).

So a 1M window folds at 128k; a 200k window at 100k; a 64k window at 32k.
The previous 75% pressure arm and the 120k span-fidelity arm are retired.
Both values are named constants in `src/turn/overflow.ts` (the
pre-emption arm needs them there without an import cycle).

Hermes also runs an 85% check at the gateway, before each incoming message,
for sessions that grew between turns. Goblin does not add one: the
end-of-turn backstop folds any turn that lands over the trigger, so a turn
never starts over it from its own history. Step-boundary pre-emption cannot
cover a turn's first call (the projection is null until a step completes);
a first call that overflows rides the overflow rail.

Manual `/compact` stays a forced fold: no trigger, window possibly unknown.
`minSpanTokens` stays: a fold that buys nothing still spends a call and
moves the cache boundary.

## Budgets

| quantity | value | source |
| --- | --- | --- |
| verbatim tail | **20,000**, ≤25% of window | pi / OpenClaw `keepRecentTokens` |
| summarizer chunk cap | 100,000 | unchanged |
| verbatim user messages | **4,000**, newest first | Hermes lean (budgeted) |
| identifier index | **1,000** | Hermes lean |

Small windows keep the old ratio as a ceiling: tail ≤ 25% of the window.
OpenClaw's shrink-to-fit (tail shrinks so prompt + tools + pending input +
reserve fit) is not adopted: with the trigger at ≤50% of the window, a
≤25% tail plus summary leaves the other quarter free. Revisit only if an
overflow right after a fold is ever logged.

## Cut rule: pi's cut, over causal order

Ruling: copy pi's cut-point algorithm (`findCutPoint` and its split-turn
handling in `packages/coding-agent/src/core/compaction/compaction.ts`). Walk
back from the newest entry until the tail budget is spent; cut there; never
between a tool call and its result.

- **Split turns.** When one turn alone is larger than the tail, pi cuts
  inside it: the turn's first part gets its own short summary
  (`turnPrefixMessages`), the rest stays verbatim. Goblin copies this. The
  previous rule (never cut inside an exchange; let a huge exchange stay
  whole) is retired — it left a 130k tool output unfoldable.
- **Goblin-only constraint: causal order.** The model view sorts each reply
  next to its question (`anchorSeq ?? seq`), not by storage seq. pi's log
  order *is* its model order; ours is not. So the cut runs over the
  causal-ordered list `modelEntries` produces, and the boundary is recorded
  as a position in that order. This is the only adaptation.
- **Goblin-only constraint: completed history.** The `beforeSeq` ceiling
  below stays in front of the cut. It came from a real P1 bug (2026-10-26):
  a running exchange must never be folded.
- **Unverified:** that pi's algorithm over causal order needs no further
  change. Branch 1 confirms against pi's code and the existing
  `chooseBoundary` tests before deleting `exchangeComplete`. If it fails,
  the fallback is Hermes's rule: the tail may go over budget; no split.

### Completed-history ceiling (kept)

Ruling added 2026-10-26 (P1 fix, review of the same day): the walk sees
**completed history only**. Events belonging to an exchange whose reply has
not landed — a running turn's stored user event, or inputs queued behind it
(a streaming submit deliberately waits out a headless turn) — are excluded
by an exclusive ceiling (`beforeSeq`) in both the pre-empt's foldability
probe and the fold itself. Without it, a queued input alone can exceed the
tail budget and park the boundary ON the running exchange; the reply then
lands anchored at exactly that boundary, `modelEntries`' causal cut drops it
from every later request, and the summary — minted before the reply existed
— never saw it. The ceiling is derived in the runtime (`foldCeiling`): the
earliest member seq while a turn runs, else the first still-queued input,
re-read when the fold reads history so late arrivals are covered. A landed
reply needs no ceiling — the anchor rule already protects its exchange.

## The summary's identity: the boundary seq, never the id

Ruling (2026-11-08, #206): `summaryMessage` is minted at read time and rides
the model view under a `compact-<boundarySeq>` id — a legibility label, never
a classification key. Client message ids are neither unique nor trusted (the
app intake stores them verbatim), and a client message whose chosen id starts
with `compact-` is an ordinary client message everywhere: memory recall,
retention eligibility, recall-block anchoring, and the resume visible set.
Every reader recognizes the summary as the entry whose **seq equals the live
compaction boundary** — a seq the store assigns and the client cannot forge.
`MemoryEligibility` carries that seq (`summarySeq`) beside the span's
eligibility stamp, so the memory-bound projection, the exchange-boundary walk,
and `withMemoryBlocks` all classify by seq; operator resume reads the boundary
from the store the same way.

## Timing: pre-empt at the step boundary

The operator's ruling: pi's mid-run timing is right. Goblin compacts mid-turn
today only as **overflow recovery**; that becomes the backstop, not the
normal path.

- **Where.** The turn loop's step boundary — the same seam steering already
  uses, before every model call including the first. The trigger is
  checked there, after tools finish and their results are appended.
- **Why pre-emption beats recovery.** Recovery costs the model call that
  already failed, runs with a tail shrunk by the overflow, and is once per
  turn — a turn that keeps growing after recovery fails outright. Pre-emption
  has none of those properties.
- **What it costs.** A fold landing between the last tool batch and the final
  answer delays that answer by up to one summary call. Accepted: the
  alternative is a 400. The delay is bounded by the chunk cap, which is why
  that cap is absolute.
- **The end-of-turn fold is retired as the normal path.** The serial-lane
  queue and `/compact` keep their semantics (`Runtime.busy` still counts a
  queued or in-flight compaction, and a resume offered while the lane holds
  work still refuses).

Implementation rulings (2026-10-25):

- **A pre-empt consumes the logical turn's one fold-resume** — the same
  budget overflow recovery draws on, enforced by the same `overflowed` flag
  on the recovery. A turn that keeps growing after a pre-empt is guarded by
  the 85% context landing (tools-off prose ending) and the overflow error
  path, in that order; both are terminal for the turn, never loops.
- **Pressure budgets the upcoming request, not the last one**: the last
  completed step's reported input plus everything appended since its
  dispatch (assistant output, tool results, steers), estimated at chars/4.
  A tool result can blow the window in one step while the previous request
  read small; null before the first completed step (pressure cannot fire
  blind — a 400 on the admitted view rides the overflow rail).
- **A trigger with nothing foldable stands down — never interrupt for a fold
  that cannot happen.** A no-op compact on the recovery rail is a terminal
  error, and the live turn's own growth is never foldable (only stored
  history is). The trigger is gate-checked with `chooseBoundary` against the
  same tail budget the eventual fold would use, under the same completed-
  history ceiling (`beforeSeq`) the eventual fold applies — queued inputs
  count toward neither the tail walk nor the boundary; a stood-down trigger
  logs and returns null. A genuinely doomed turn — live content alone over
  the window — still fails honestly through the overflow rail (a real 400,
  not a projection). Regression pin 2026-10-25 (a fresh conversation whose
  130k-token tool output crosses the trigger completes untouched) is
  revisited in stage 1: with split turns that output becomes foldable.
- **A context landing that issues at the same boundary retracts** — the
  pre-empt supersedes the tools-off ending (`TurnState.retractContextLanding`);
  the resume starts unforced with tools on. A repeat/watchdog cut never
  retracts: it is a verdict about the loop, not the window.
- **The trigger measures at `prepareStep`** (`preemptArm` in
  `src/turn/overflow.ts`): the projected upcoming request, at chars/4. An
  estimate — a trigger, not an accounting system.
- **The signal rides the overflow rail.** The `PreemptSignal` thrown from the
  step boundary surfaces as a failed outcome with `holdForRecovery`, becomes
  a `PreemptCompactError` at the runtime boundary, and flows through
  `recoverFromOverflow` unchanged — full tail, compact reason `preempt`, one
  resume with the partial continued and journaled calls guarded.
- **A failed pre-empt fold resumes unfolded — it never ends the turn.** The
  trigger fired before the window was full, so a `compact()` throw or a raced
  `noop` is not the overflow story ("context window full …") and not
  terminal: the recovery resumes on the uncompacted view with the same
  spent budget — the trigger cannot re-fire, and a still-growing turn meets
  the context landing or a real 400 as itself. Ruling added 2026-10-30:
  previously a summarizer outage ended every turn that crossed a
  threshold with a false window-full error.

Invariants carried over unchanged, because they are not about timing: the
authority fence checked before each chunk and before the pointer lands; a
failed fold writes no pointer and warns; `/stop` or shutdown aborts; the
epoch is re-compared between compaction and the resume decision; the frozen
system-prompt snapshot clears at a landed boundary — including one landing
mid-turn, where the rewrite is a sanctioned prefix move (a fold busts the
prefix regardless).

## The summary

The conversation's own model writes it (unchanged ruling). It receives the
previous summary plus the newly folded span, never the whole past
(iterative, as pi/OpenClaw/Hermes).

**Required headings** (OpenClaw safeguard mode, its exact list):

```
## Decisions
## Open TODOs
## Constraints/Rules
## Pending user asks
## Exact identifiers
```

**Code-made parts** (Hermes lean), appended by code after the model's text,
never passed through a model:

1. **Identifier index.** A regex pass over the folded span: IDs, numbers
   with units, URLs, paths, SHAs, error strings, quoted names. Deduped,
   newest first, within budget. Cannot be paraphrased.
2. **Verbatim user messages.** Every real operator message in the folded
   span, quoted exactly, newest first, within budget. Program prompts,
   system notes and resume requests are not "real". Standing instructions
   ("don't drop Herbert") are what must never decay.
3. **Recovery pointer.** The existing marker line: conversation id,
   boundary seq, `history_search action="context"`. The tool already
   exists (`src/agent/tools/history.ts`); nothing new is built.

**Carried across folds.** The stored summary is the model's text, a fixed
marker line, then the code-made sections as one JSON string per line. The
next fold parses it back: only the model's text goes to the summarizer;
the code merges the new span's quotes and identifiers in front of the
carried ones, dedupes, and cuts each list to its budget. A summary with no
marker (written before stage 2) is all model text.

## Quality audit (OpenClaw)

After the model writes the summary and before the pointer lands:

- all five headings present;
- the latest operator request in the folded span is reflected in the
  summary (OpenClaw's word-overlap check: up to 12 distinct meaningful
  words, 2 matches when there are 3 or more). OpenClaw checks the whole
  summary, not only `Pending user asks`, unless it knows the ask is
  unresolved; goblin has no such signal (the span is completed history, so
  the ask may be done), so it does the same;
- the `Exact identifiers` check is dropped: the code-made index carries
  identifiers by construction.

A failed audit retries with a corrective instruction, at most **2** retries.
Still failing: **write nothing**, warn, keep the full history — the same
"failed fold writes no pointer" rule goblin already has. The previous
rejection of retry-on-deficient-summary applied to ledger folds and goes
with them.

## Memory flush (OpenClaw), gated

Before a fold, one silent model turn tells the agent to save durable facts
from the span about to be folded to its notes (`note` tool).

**The gate:** the flush runs only when the `memory` config block is absent.
With memory configured (Hindsight), events reach memory by the memory
outbox, so a flush is a wasted call. Removing the `memory` block turns the
flush on with no other change.

- A memory-excluded conversation never flushes: exclusion means nothing
  durable leaves it.
- The flush is optional maintenance (OpenClaw): its failure warns and the
  fold continues.
- Outbox order holds (checked 2026-11-09, #405): `appendMessages` enqueues
  a turn's memory document in the same SQLite transaction that stores its
  completed assistant event, and a fold only covers completed history
  (`foldCeiling`, `exchangeComplete`). So every folded event that memory
  retains was queued before the fold could read it.
- **Mechanism (operator, 2026-11-09):** one direct `generateText` call in
  the fold job with only the `note` tool (at most 8 steps), before the first
  summary chunk. No runtime turn, no stored reply: a hidden turn would run
  in the lane the fold already holds. The call sees the newest slice of the
  span that fits `inputTokenBudget`, shares the summary call's timeout, and
  logs `compaction flush` (events, chars, truncated, noteCalls). `/stop`
  aborts it and the fold together; any other failure warns.
- **Reasons (operator, 2026-11-09):** every fold except `overflow` — that
  one recovers mid-turn from a provider error, and an extra call only
  delays the answer.
- A claude-code conversation never flushes: its compaction lane is
  text-only, with no tool to save through.

## Overflow recovery

Unchanged in shape, now OpenClaw's contract stated explicitly: on a
provider context-overflow error, fold and retry the request; finished tool
calls are never run again (the journaled-call guard already does this). It
stays the backstop behind pre-emption.

## Fold marks in the app

Ruling: a fold mark (the pill) renders **where the fold ran**, not at the
cut — pi and OpenClaw both put their compaction entry at the point it
happened, and the cut-position pill read as wrong (operator, 2026-11-09).

- Placement: after the last message whose `created_at` is at or before the
  compaction row's `created_at`. Derived at read time in
  `src/http/app-conversations.ts`; no schema change, so existing rows move
  too.
- The expanded pill names where the model's context now starts (the first
  kept message) and how many messages were kept.
- Count wording stays "messages"; a scheduled run is several messages
  (program prompt, reply, notes), and the expanded view lists them.

## Schema

No new table. `compactions` keeps its columns; the summary text now carries
the headings and code-made parts. No migration: old rows render as before
(their pill moves to fold time, per above).

## Staging

1. **Triggers, tail, cut.** 50%/128k trigger, 20k tail,
   pi's cut over causal order with split turns, overflow contract.
2. **Summary contents.** Required headings, quality audit, identifier
   index, verbatim user messages, gated memory flush.
3. **Fold marks.** Pill at fold time.

Each stage is its own issue and branch. Tool-result pruning is not a stage:
`src/cache-pruning.ts` already does cache-aware pruning (OpenClaw's
`cache-ttl` mode), and pruning every request would break the prompt cache.

## Non-goals

- Provider-native opaque compaction (Codex's `/responses/compact`). Its
  contents cannot be inspected or audited, and it abandons the recovery
  pointer.
- A deterministic fallback summary (Hermes has one). Unchanged ruling
  (2026-10-04): a degraded summary silently harms every later turn; a
  failed fold writes nothing instead.
- Hermes micro-compaction (fold one exchange per turn). It breaks the
  prompt cache every turn; Hermes ships it off by default.
- Branch summarization. Goblin conversations are linear.
- A transcript dump beside the pointer. The event stream is the record.

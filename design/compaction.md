# Compaction — architecture ruling

Core law is [`DESIGN.md`](../DESIGN.md); the incumbent prose summary's live
contract is `design/model.md` → "Compaction". This file rules the **second**
compaction method (ledger compaction), the budgets that bind both methods,
and the timing change that moves compaction from the end of the turn to the
step boundary.

Provenance: operator session 2026-10 — comparison of pi / OpenCode / Codex /
Gemini CLI / Qwen Code / Cline / Roo / Kilo / Goose / OpenHands / OpenClaw /
Aider / SWE-agent, and the resulting ruling that pi's mid-run timing and
absolute budgets are right, 1M-token windows are the target scale, and the
recursion problem is solved by class separation rather than by a better
summary. Mechanisms borrowed (never scope) from `~/build/pi-mono`
(step-boundary pre-emption, cumulative file tracking, structured summary
format, branch summarization) and `~/build/testing/openclaw` (pre-compaction
durable flush, summary validation) — see AGENTS.md → Design inspiration.

**Status:** stage 1 implemented 2026-10-25 (budgets, both trigger arms,
step-boundary pre-emption — summary method only, no new table; the
`Ledger`/`Atlas`/understudy stages below remain ruling-only). The
incumbent summary method is what runs in prod for every fold.

## The problem with the incumbent

`runCompaction` folds a span into prose, and the next fold receives that prose
as `carried` context. That is recursive lossy summarization: information
dropped at fold *n* cannot be recovered at fold *n+1*, because fold *n+1*
never sees the original. Left unaddressed it produces three failures —
information loss, drift toward the oversimplified, and false confidence (the
model treats the summary as authoritative precisely where it is thinnest).

The obvious fix — a longer or better-prompted summary — does not work,
because the pressure is structural: **compression ratio scales with span
size**, and span size scales with the window. On a 64k window a fold is
roughly 7:1. On a 1,048,576-token window goblin's current fractions put the
first fold at ~524k tokens into the same few-thousand-token summary — roughly
130:1. No prompt makes that compression faithful.

The rule that follows: **recursion is acceptable only for the class of
information that is allowed to decay.** Everything load-bearing must be
carried in a form that never passes through a model twice.

## The two methods

Both methods relocate the same pointer over the same append-only event
stream. They differ only in what the model view carries before the tail.

- **Summary (incumbent).** Prose. One model-authored summary replaces the
  folded span. Stays the default until ledger compaction proves itself, and
  remains the only method that can run when a conversation's model is the
  only inference available.
- **Ledger.** Structured carried state in three classes (below). The
  authoritative part is model-authored **once per record** and thereafter
  quoted verbatim; the map is built by code.

Selection is per conversation and recorded on the compaction row, so a
conversation never mixes methods across folds — a mixed lineage has no single
answer to "what does the model currently believe". Switching is an explicit
operator action, logged as a cache boundary like any other rewrite.

Overflow recovery keeps using the **summary** method even for a ledger
conversation: it runs mid-turn against a hard failure, must produce one
bounded call, and cannot wait for record extraction.

## Carried state: three classes, three decay rules

This is the ruling that answers "how do you bound recursion". Loss is
confined to the class that may lose.

1. **Ledger — authoritative, append-only.** Decisions, commitments, standing
   instructions, open work, identifiers, rejected approaches. One record per
   fact, shaped by zod at the boundary, citing the source event seqs that
   justify it. Records are **added** or **superseded**; a record's text is
   never rewritten by a later fold. A supersede names its predecessor, so
   "what did we believe then" stays answerable. This class never enters the
   recursion: fold *n+1* sees records, not a summary of records.
2. **Atlas — deterministic, code-built.** Where things are: one line per
   folded interval (boundary seq, date, who, salient terms), plus the
   cumulative touched-file list (mechanism from pi). No model call, no
   paraphrase, no drift. The atlas is what makes the folded span *navigable*
   — it names the address the model needs to call `history_search`.
3. **Narrative — lossy, marked as lossy.** A per-interval prose note carried
   in the view and explicitly labelled non-authoritative. This is the only
   class that composes recursively, and it is safe to let it degrade because
   the view says so. The model is told: ledger and atlas are authoritative;
   narrative is a convenience that may have dropped things.

Rendered order in the model view: ledger → atlas → narrative → verbatim tail.
The incumbent's `summaryMessage` marker keeps its job (naming the
conversation id, the boundary seq and `history_search action="context"`) and
is emitted for both methods; the ledger does not replace the recovery door.

## Triggers: two arms, either fires

Window utilization is inherently relative; fidelity budget is inherently
absolute. Both are real, so both are triggers.

- **Pressure (safety).** A completed step or turn whose projected context
  crosses **75%** of the catalog window. Unchanged from today. At 1M this
  almost never fires, which is correct: it exists to prevent hitting a wall,
  not to schedule work.
- **Span fidelity (normal).** The unfolded span since the previous boundary
  crosses **120,000 tokens**. This is the arm that actually runs at 1M.
  It exists because the fold is the lossy step and span size sets its loss;
  folding earlier is the only lever on fidelity.

`chooseBoundary`'s `minSpanTokens` floor stays (a fold that buys nothing is
not free — it spends inference and moves the cache boundary), raised from
500 to a value that clears the atlas+narrative it will produce.

A manual `/compact` remains a forced fold: it ignores both arms and runs
with the window unknown.

## Budgets: absolute, not fractions

The budget a quantity gets is set by what it is *for*, not by what the
window permits. Catalog windows change; task continuity and summarizer
reliability do not.

| quantity | why it has a size | value |
| --- | --- | --- |
| verbatim tail | what the work in flight needs | **30,000** |
| summarizer chunk cap | what one call can fold faithfully | **100,000** |
| ledger render | carried facts, gently scaling | **6,000**, hard cap 20,000 |
| atlas | navigation, not prose | ≤ 2,000 |
| narrative | convenience only | ≤ 1,500 |

Retiring the fractions is the substance of this section: at 1M, "keep 25%"
meant a 262,144-token tail riding every call and "chunk at 50%" meant a
524,288-token summarizer call. Neither is a bigger version of the small-window
behavior; both are different, worse behavior.

Implementation ruling (2026-10-25): the absolute values are **caps, not
replacements** — below 120k (tail) / 200k (chunk) of window the historic
ratios still bind, so a small model keeps exactly its old budgets and a
1M model gets the cap. `compactionBudgets(window)` in `src/runtime.ts` is
the one function that owns this; a null window (manual `/compact`, catalog
silent) takes the absolute values.

## Cut rule: exchange-complete, over completed history

`chooseBoundary`'s exchange-complete rule stands: a cut is legal only where
no later event anchors at or before the boundary. For a linear transcript
this is a strict generalization of pi's "cut at a user-message span start,
never between a tool call and its result" — every pi cut satisfies the anchor
rule, and the anchor rule additionally handles the case pi's cannot see, a
steer arriving mid-turn that has no span start of its own. Bursts stay atomic
and the cut still coarsens to whole bursts.

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

## Timing: pre-empt at the step boundary

The operator's ruling: pi's mid-run timing is right. Goblin compacts mid-turn
today only as **overflow recovery**; that becomes the backstop, not the
normal path.

- **Where.** The turn loop's step boundary — the same seam steering already
  uses, before every model call including the first. Crossed arms are
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
- **An arm with nothing foldable stands down — never interrupt for a fold
  that cannot happen.** A no-op compact on the recovery rail is a terminal
  error, and the live turn's own growth is never foldable (only stored
  history is). Both arms are gate-checked with `chooseBoundary` against the
  same tail budget the eventual fold would use, under the same completed-
  history ceiling (`beforeSeq`) the eventual fold applies — queued inputs
  count toward neither the tail walk nor the boundary; a stood-down arm
  logs and returns null. A genuinely doomed turn — live content alone over
  the window — still fails honestly through the overflow rail (a real 400,
  not a projection). Regression-pinned 2026-10-25: a fresh conversation
  whose 130k-token tool output crosses fidelity must complete untouched.
- **A context landing that issues at the same boundary retracts** — the
  pre-empt supersedes the tools-off ending (`TurnState.retractContextLanding`);
  the resume starts unforced with tools on. A repeat/watchdog cut never
  retracts: it is a verdict about the loop, not the window.
- **The fidelity arm measures at `prepareStep`**: history chars minus the
  carried summary's chars, at chars/4 (`preemptArm` in `src/turn/overflow.ts`).
  An estimate — a trigger, not an accounting system.
- **The signal rides the overflow rail.** The `PreemptSignal` thrown from the
  step boundary surfaces as a failed outcome with `holdForRecovery`, becomes
  a `PreemptCompactError` at the runtime boundary, and flows through
  `recoverFromOverflow` unchanged — full tail, compact reason `preempt`, one
  resume with the partial continued and journaled calls guarded.

Invariants carried over unchanged, because they are not about timing: the
authority fence checked before each chunk and before the pointer lands; a
failed fold writes no pointer and warns; `/stop` or shutdown aborts; the
epoch is re-compared between compaction and the resume decision; the frozen
system-prompt snapshot clears at a landed boundary — including one landing
mid-turn, where the rewrite is a sanctioned prefix move (a fold busts the
prefix regardless).

## Validation: a manifest, not a retry gate

After a fold lands, code extracts salient tokens from the folded span —
paths, identifiers, numbers, names — and checks that the ledger plus atlas
carries each one. Misses are not a failure; they are printed into the view
for exactly one interval as an explicit **known-missing** list, so the model
knows what it does not know instead of being confidently wrong. Retry-on-
deficient-summary (mechanism from OpenClaw's guarded summarization) is
rejected for ledger folds: the well-formedness gate is the zod parse at the
record boundary, and a malformed extraction fails loudly without writing a
pointer.

## What this changes in the schema

- `compactions.method` — `summary` | `ledger`, per fold, so a lineage's
  method is auditable.
- `ledger_records` — id, conversation, kind, text, source seqs, superseded_by,
  created_at. Additions and supersedes in the **same transaction** as the
  pointer write, so no crash window leaves records without a boundary or a
  boundary without its records.
- The atlas is derived, not stored: it is rendered from `events` at read
  time, which is why it cannot drift.

## Staging

1. **Budgets and triggers, summary method only.** Absolute tail and chunk
   caps, the span-fidelity arm, step-boundary pre-emption. No new method, no
   new table. This is where most of the value is, and it is testable against
   the incumbent behavior directly.
2. **Ledger records and the atlas.** Extraction at fold time, rendered view,
   known-missing manifest, inspection surface (app + `/ledger`).
3. **Understudy.** Continuous per-exchange digestion on free models
   (pi-durable pool), so a fold commits already-extracted records and spends
   no strong inference on maintenance. This is what makes folding often
   affordable, and folding often is what the 1M span-fidelity trigger wants.
4. **Same-conversation retrieval at admission** — deferred, and it needs its
   own ruling. It collides with locked memory rulings (recall blocks persist
   verbatim, memory-excluded conversations have no recovery path).

## Non-goals

- Provider-native opaque compaction (Codex's `/responses/compact`). Contents
  cannot be inspected, edited, or audited; it also abandons the recovery door
  that makes goblin's folded history usable.
- A deterministic fallback summary. Unchanged ruling (2026-10-04): the
  summarizer is the conversation's own model, and a degraded summary silently
  harms every later turn. The known-missing manifest is disclosure, not a
  fallback summary.
- Branch summarization. Goblin's conversations are linear; a rolling DM rolls
  to a fresh conversation instead. The atlas does not need a tree.
- Bundling a transcript dump alongside the pointer. The event stream already
  is the record; a copy would drift (`design/model.md`, 2026-10-14).

# Assessment of the remaining reference-review queue

Source baseline: `c63af11d` on `main`. Reviewed the handoff at
`/tmp/agent_handoff.y5BGkI/handoff.md`, its audit snapshot, current source,
`DIRECTION.md`, and `ROADMAP.md`. Recommendations below are not operator-approved
design rulings or implementation authorization.

## Verdict

F1 addresses a real continuity defect. Pursue it in small, useful slices, not
as a prerequisite architecture-cleanup programme before the roadmap's real-work
pilot. Design F4 alongside it; defer F5 pending a corrected ownership analysis.
Keep F6 evidence-gated. The promised deletions are hypotheses, not acceptance
criteria.

## F1: retain the goal, narrow the first slice

Completed failed-turn progress is absent from ordinary next-turn admission.
The smallest useful outcome is to expose that progress, its owning run, and
its terminal status without duplicating the final reply. Leave split-turn
compaction, automatic retry, wake ownership, and resume policy unchanged
in that slice.

The existing checkpoint is not a lossless transcript waiting to be projected:
`src/turn/stream.ts` stores assistant messages only, tool results live separately,
and `src/turn-journal.ts` bounds results and can strip reasoning ciphertext
and drop oldest checkpoint messages. Establish a durable record/projection
contract before switching the view.

Durable steps do not close the crash window between an external effect and its
result commit. Current dispatch-before-execute and result-before-return
journaling, replay decisions, and retry grants protect distinct guarantees
(`src/runtime.ts`, `src/turn/retry-guard.ts`). Preserve those guarantees until
their replacements exist. An interrupted-result marker is not proof of
exactly-once execution.

Split-turn compaction deserves a later slice with its own causal-boundary and
anchor proof (`design/compaction.md`, `design/runtime-turn.md`). Removing the
current ceiling alone can hide a later anchored reply. `TurnRecovery` also
carries loop, admission, stream, and fallback state, not just partial messages.

## F4: durable admission/outcomes, not reconciliation deletion

Runtime-owned submission outcomes are a useful direction. Observer-maintained
ownership hooks may shrink if admission, membership, and terminal transitions
become atomic. Wakes still need reconciliation for append/admit gaps, missed
observation, authority epochs, backoff, and interrupted work.

Preserve conversation-plus-event-seq identity, legacy fail-closed claims,
pre-run failures, and overflow/resume ownership transfer. Do not treat every
unlinked legacy claim as safely queued.

## F5: correct the premise before authorizing migration

This work is independent of F1 and is debt reduction, not an established defect.
Two audit claims overstate duplication:

- `inbox` contains imported sandbox/desktop file paths, not pi's queued input
  submissions (`src/subagents/transfer.ts`).
- The row's input revision can describe newer admitted intent while
  `RunDoc.inputRev` names the input actually consumed by a request, bounded by
  its checkpoint cutoff (`src/subagents/tools.ts`, `bindConsumedInput`).

Approval truth already includes a task-scoped lease; routing and pending
decisions have separate responsibilities. Moving fields requires preserving
those distinctions. Also prove a supported atomic submit/doc mechanism:
the installed transaction's raw `createSubmission` explicitly lacks the
busy/inbox/placement semantics of `Conversation.submit()`.

## Small leftovers and sequencing

1. Close quota-filter contract/test gaps, including the unpinned 5xx case,
   retained error fields, and warning line; do not assume every quota-bearing
   5xx necessarily means the same thing.
2. Rule and implement F1 failed-turn visibility.
3. Pilot continuity on useful work; exercise crash/ambiguity separately in
   isolation. Then pursue split-turn compaction and F4 in independent slices.
4. Reassess F5 with the corrected ownership map. Do F6 only with real,
   unit-labelled provider evidence; character limits are not token limits.

Reviewer copy-returning wrappers are a small independent cleanup, not another
demonstrated authority bypass: these file tools are freshly constructed.
Doctor already makes every warning fail `--strict` (`src/doctor.ts`); recommend
retaining that simple contract rather than adding a ratio-specific exception.
The source/test line ratio is a smell, not a target for deleting safety tests.

## Verification

Two read-only delegated source reviews informed this assessment.
`bun test src/doctor.test.ts src/agent/providers.test.ts
src/agent/provider-errors.test.ts`: 83 passed, zero failed.
`bun run typecheck`: both programs passed.
These are bounded checks, not a full-suite or live-provider result. No runtime
implementation, service, deployment, push, or live operator work was changed.

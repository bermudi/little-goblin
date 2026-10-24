# The Way Forward

Recommended sequence grounded in [DIRECTION.md](DIRECTION.md), not blanket
implementation or deployment authorization. Reorder in response to actual use;
do not treat this as a dependency graph requiring every feature before Goblin
can be useful.

Baseline inspected: `3181e943` on `main`, after the first handover milestone.
The source inspection did not establish the live deployment's version or
whether an operator pilot has already happened. Ask for missing usage evidence,
not for settled product preferences.

## What We Can Build On

| Capability | Current source |
| --- | --- |
| Project-owned work, understanding, attachments, generations, prompt operations | `src/responsibilities.ts`, `src/responsibility-service.ts` |
| Deterministic Herdr observation; cursor/event/wake persistence | `src/responsibility-observer.ts` |
| Append-once triggers, run ownership, crash/retry reconciliation | `src/wake-store.ts`, `src/wake-dispatcher.ts`, runtime and turn journal |
| Project-directed Programs and automatic follow-up linking | `src/programs.ts`, `src/scheduler.ts`, responsibility service |
| Project tools, feed pills, correction and lifecycle controls | `src/agent/tools/responsibility.ts`, `src/http/app-responsibilities.ts`, `app/src/ResponsibilityFeed.tsx` |
| Primary app, shared approvals, Attention, push, settings and account management | App, HTTP, and channel-neutral domain owners |
| Latest outbound context window and call lineage | `src/window-capture.ts`, `app/src/WindowView.tsx` |

Do not rebuild these under new names. Extend their owners and preserve the
existing adapter boundaries.

Known distinctions at this baseline:

- Herdr observation is code-only every minute, but active responsibilities
  default to a model-waking Program every 15 minutes, up to 96 scheduled
  occurrences per active responsibility per day. That is not yet economical
  judgment about when follow-up is useful.
- The feed is responsibility-centered inspection inside Projects, not yet
  the outcome-led front door. Attention is a separate operational projection.
- Completion expectations exist, but `complete` itself is a status change:
  it does not require a completion report or verification evidence.
- Managed sends check identity before and after sending. There is still a
  check/send race, explicitly treated by the implementation as an accepted
  residual risk. A server-side guarded send is not implemented in this path.
- Production pi-durable worker models remain pinned; alternate-model profiles
  are a constrained seam, not a free-model delegation product.
- Ratings are record-only, project memory is shared/off, and the context-window
  capture is latest-wins rather than a per-reply incoming-memory history.
- Coordination conversations are protected from deletion, including for
  terminal responsibilities. Session replacement support does not imply free
  migration between coordination conversations.

At inspection, 432 selected tests across 21 files and both TypeScript programs
passed. This is bounded evidence, not a full-suite result or live acceptance.

While recording this roadmap, the full non-live suite ran: 4,840 passed,
86 skipped, and one experimental retry test failed because its transcript did
not yet contain "All done." (`experimental/pi-approval/crash.test.ts:294`).
That test passed on an isolated rerun; the full run is still not green.
Typechecking and the direction/roadmap links passed. No runtime source changed.

## Next Acceptance Target: Carry One Project Without Babysitting

The operator hands over useful existing work once, can leave it alone, and
returns to understand what moved, what needs judgment, and what is evidenced.
Goblin does not spend the allowance saying "still working," manufacture
completion, or leave the operator to reconstruct progress from machinery.

The first two stages below serve this same target. A representative pilot is
the proving ground throughout, not a ceremony after building everything.
Re-use actual pilot evidence if it already exists.

## 1. Make Follow-Through Deliberate

Outcome: Goblin remembers why and when to check, without a blanket inference
heartbeat becoming the default cost of every responsibility.

Scope:

- Represent the next commitment: what is owed, why another check is needed,
  and when to assess it. Extend the existing responsibility/Program owners;
  do not introduce a second scheduler.
- Wake for meaningful developments, due commitments, and task-appropriate
  silence/progress limits. An unchanged status is not automatically "nothing
  to do": stalled work and missing events still need a backstop.
- Give coordination tools a usable way to express active, blocked, and
  waiting-for-operator states, with the reason and resumption condition.
  The store has these states; the tool currently cannot directly select the
  latter two.
- Avoid repeated model calls while waiting for the operator unless an agreed
  reminder or consequential change warrants one. Coalesce covered obligations
  without discarding distinct developments.
- Make pause, cancellation, project archive, corrections, and resumption
  consistent across scheduling, observation, and dispatch. Preserve in-flight
  effect honesty and never close adopted workspaces.
- Record a concise completion assessment with evidence references and what
  was actually verified. A failed check keeps the work open or blocked;
  a task-specific checkpoint waits without redefining every finish as review.

Acceptance:

- A quiet active agent causes ordinary observations, not a model turn every
  15 minutes merely because the default cron elapsed.
- A completion candidate, question/blocker, due promise, or exceeded silence
  bound still gets timely assessment. Suppressing calls must not lose work.
- Waiting, pausing, archiving, correcting, and resuming have observable effects;
  queued/stale actions cannot regain authority.
- Commitments and their dedupe identity survive restart and recover without
  duplicate sends. Existing wake/journal invariants stay intact.
- "Done" with failing evidence does not close the responsibility. A verified
  operational outcome can close without a universal human approval.
- The operator can inspect why the next wake is scheduled, why one was skipped,
  and what inference was spent, without inspecting raw logs.

Start here: a narrow follow-up-policy slice on the existing linked Program,
with deterministic-clock tests and visible reason/due time. Establish the
observable contract before choosing fields or changing scheduling semantics.
Do not bundle a full feed redesign or model router into that first change.

## 2. Bring Back Outcomes, Not Just Activity

Outcome: the feed becomes the useful front door; chat deepens or steers an item.

Scope:

- Add durable outcome items for findings, drafts, meaningful changes, questions,
  and completed work, linked to their project/responsibility, evidence, and
  originating conversation. Extend existing durable work; avoid a duplicate
  task database or a separate chat history.
- Keep routine activity in expandable pills. Repeated check-ins are not posts
  unless they produce something worth seeing.
- Distinguish worker-produced, unreviewed, and Goblin-assessed content.
  Review policy depends on the work, not a universal publish gate.
- Bring the cross-project feed to the app's home experience. Integrate or
  clearly connect Attention rather than creating two competing places to watch.
- An item opens its project/conversation; comments and corrections retain
  item context. Existing inspection, approvals, and recovery stay reachable.
- Use existing UI rendering primitives where they help express a comparison,
  decision, or artifact. No new generative-UI framework is needed.

Acceptance:

- The operator can return after time away and see the result, what changed,
  and the actual decision needed without opening every conversation.
- Agent activity is visible but does not bury useful outcomes.
- Reload preserves posts, evidence, review state, and corrections.
- A comment reaches the right ongoing work; it is not an unanchored global
  chat message. Inspection can explain the item's sources and actions.
- Empty, stale, failed, desktop, and mobile states are intentional.

First combined pilot: explicit handover, a real development or blocker, an
operator correction, a controlled restart, and evidenced completion. Separately
exercise failure paths in isolation. Live prompts, service restarts, and other
consequential operations retain their normal authorization requirements.

## 3. Add Useful Cheap Capacity

Outcome: Goblin can use an explicitly configured free model for a bounded
lower-stakes assignment through pi-durable, then assess the evidence.

Scope:

- Expose a free-worker capability on the existing durable runtime. Make the
  assignment, model/provider, resource limits, result, and failure visible;
  do not build a throwaway API wrapper or choose providers without the operator.
- Extend worker tools for the chosen research job, sandboxing less-trusted
  tool use and limiting supplied context to what the assignment needs.
- Queue work, bound retries/fan-out, report unavailable/exhausted capacity,
  and never silently substitute paid inference.
- Check evidence with methods appropriate to the assignment. Main-model or
  capable-harness review is selective, not mandatory duplication of every call.
- Publish useful findings into the same feed and link them to the work.

Acceptance:

- A bounded sourced comparison, supplied-material summary, or lead-research
  assignment survives interruption and returns inspectable evidence.
- A bogus or unsupported claim is rejected or visibly unverified, not promoted
  because several workers agree.
- Capacity exhaustion produces a clear deferred/blocked result without a
  retry storm, paid fallback, or lost assignment.

Business prospecting remains a delegation use case, not a mandate to turn this
roadmap into choosing the operator's offer or building a sales product.

## 4. Close The Steering And Memory Loops

Outcome: Goblin learns correctable lessons from feedback and respects project
memory boundaries in a way the operator can inspect.

Two independently shippable tracks, not blockers for the earlier pilot:

- Feedback: attach reactions/comments to the item and its context; form a
  tentative interpretation; occasionally ask a targeted clarification.
  Show and allow correction of an interpretation before treating an ambiguous
  dislike as a permanent preference. Do not force homework after every vote.
- Memory: implement project shared/separate/off consistently across recall,
  retention, migration, and controls. Separate projects must not bleed into
  shared recall. Expose incoming sources at the useful conversation/reply
  boundary without pretending the existing latest-window view is a full trace.

Acceptance: a corrected interpretation changes subsequent behavior with visible
provenance; project isolation holds across recall and retention; memory-off
does not disable explicit work state or follow-through.

## Longer Horizon: Native Work Through Pi-Durable

Grow roles, assignments, histories, budgets, and execution workflows from real
repeated work. Responsibility remains independent of any harness. Move suitable
heavy execution into Goblin-native workers as capabilities and inference access
allow; keep the Herdr bridge useful until replacement is actually demonstrated.

Do not build the entire managed workforce before proving the next outcome.
Do not confuse "native" with cheaper subscription economics or retire capable
coding harnesses merely to make the architecture look finished.

## Risk And Proof Discipline

The Herdr identity race remains explicit. Verify the current boundary before
claiming stronger guarantees. A capability-advertised server-side identity
guard would address the race; more client reads do not. This targeted work can
proceed alongside the product stages, without becoming a blanket permissions
project or pretending previously accepted risk disappeared.

For each slice: inspect current source, name the protected invariants, implement
in small working commits, and run relevant tests plus the repository gates.
Use real SQLite and killed-process tests for recovery; fake providers and
adapter runners at the edge; separately verify unowned interfaces in isolated
live contract checks. Never infer contract proof from invented fixtures.

Keep three claims separate: implemented, tested in isolation, and demonstrated
on useful live work. Record which evidence exists before moving a stage to done.

## Resume And Maintain

A new session should read `AGENTS.md`, `DIRECTION.md`, and this file, then inspect
the changes since the baseline. Start with the next unmet acceptance target,
not the old transcript or a fresh round of product discovery.

Update the baseline and mark accepted outcomes with source/test/pilot evidence
as work lands. Keep open limitations explicit. Change direction only with the
operator; adjust sequencing when code or actual use supplies better evidence.

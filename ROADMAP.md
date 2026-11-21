# The Way Forward

Recommended sequence grounded in [DIRECTION.md](DIRECTION.md), not blanket
implementation or deployment authorization. Reorder in response to actual use;
do not treat this as a dependency graph requiring every feature before Goblin
can be useful.

Baseline inspected: `3181e943` on `main`, after the first handover milestone.
Follow-up policy implementation starts from `241178ee`; progress is recorded
under stage 1 rather than presenting the entire stage as complete.
The source inspection did not establish the live deployment's version or
whether an operator pilot has already happened. Ask for missing usage evidence,
not for settled product preferences.

## What We Can Build On

| Capability | Current source |
| --- | --- |
| One-shot wakes on a T3 thread, a PR or a time | `src/watches.ts`, `src/watch-observer.ts`, `src/agent/tools/watch.ts`, `src/github.ts`, `src/t3.ts` |
| Append-once triggers, run ownership, crash/retry reconciliation | `src/wake-store.ts`, `src/wake-dispatcher.ts`, runtime and turn journal |
| Operator-approved Programs (cron, hook, mail) | `src/programs.ts`, `src/scheduler.ts`, `src/program-proposals.ts` |
| Primary app, shared approvals, Attention, push, settings and account management | App, HTTP, and channel-neutral domain owners |
| Latest outbound context window and call lineage | `src/window-capture.ts`, `app/src/WindowView.tsx` |

Do not rebuild these under new names. Extend their owners and preserve the
existing adapter boundaries.

Known distinctions at this baseline:

- The `watch` observer is code-only every minute. A watched thread or PR
  costs no model turn until it changes; then one wake fires and the watch
  ends.
- A subagent (`agent`) runs on the parent's model unless its agent type
  names one; that `model` field is a constrained seam, not a free-model
  delegation product.
- Ratings are record-only, project memory is shared/off, and the context-window
  capture is latest-wins rather than a per-reply incoming-memory history.
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

Goblin is a loop with tools and connectors (operator, 2026-11-21, #842).
Code no longer starts issue builds or watches PRs: Goblin drives T3 Code
with the `t3` CLI through `bash`, and how it builds, picks a model, a base
and a branch lives in the operator's skill. Delegation roles and the
`delegation.defaults` table are gone; every `delegate` call names its
harness. #844 adds the `watch` tool (a T3 thread, a PR, a time) and removes
responsibilities, handover records, the work feed, reminder pushes and
the observer health check; their tables stay on disk, unread. The pilot: the operator hands over one
real issue from Telegram, and it ends merged with a verifier verdict on the
PR, without the operator relaying between agents. It remains unverified.

## 1. Make Follow-Through Deliberate

Outcome: Goblin remembers why and when to check, without a blanket inference
heartbeat.

Removed (operator, 2026-11-21, #844): the four responsibility slices that
built this in code — follow-up clocks, reports and derived stages, linked
worker reports, and queued authority stamps. They were implemented but never
piloted. Goblin now follows through with the `watch` tool and its skills,
and it keeps what it owes in its own notes (DIRECTION.md → A Loop With Tools
And Connectors).

Acceptance:

- A quiet T3 thread or an open PR causes no model turn until it changes.
- A watched change gets exactly one turn, with the reason Goblin gave.
- A watch survives a restart, and a fire is never lost or doubled.
- The operator can see which watches a conversation holds (`watch list`).

## 2. Bring Back Outcomes, Not Just Activity

Outcome: the operator returns after time away and sees the result, what
changed, and the decision needed, without opening every conversation.

Removed (operator, 2026-11-21, #844: "Remove now, post tool later"): the
responsibility feed and its outcome posts. Attention stays for decisions:
program approvals, memory, skills and delegations.

Next: a `post` tool that Goblin calls to publish a finding, draft, change
or result, and an app view of those posts. Goblin decides what is worth a
post; code does not derive it.

Acceptance:

- Agent activity is visible but does not bury useful outcomes.
- A post opens the conversation it came from.
- Empty, stale, failed, desktop, and mobile states are intentional.

## 3. Add Useful Cheap Capacity

Outcome: Goblin can use an explicitly configured free model for a bounded
lower-stakes assignment through an `agent` child, then assess the evidence.

Scope:

- Expose a free-worker capability as an agent type that names the model and
  a narrow `tools` list (design/agents.md → Agent types). Make the
  assignment, model/provider, resource limits, result, and failure visible;
  do not build a throwaway API wrapper or choose providers without the operator.
- Extend worker tools for the chosen research job, sandboxing less-trusted
  tool use and limiting supplied context to what the assignment needs.
- Queue work, bound retries/fan-out, report unavailable/exhausted capacity,
  and never silently substitute paid inference.
- Check evidence with methods appropriate to the assignment. Main-model or
  capable-harness review is selective, not mandatory duplication of every call.
- Publish useful findings as posts (stage 2) and link them to the work.

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
- Skills as procedural memory (operator decision 2026-11-16, #626): the
  agent saves what it learns as skills itself — new skills proposed for
  the operator's yes, extensions to installed skills direct; `/learn`
  authors a skill from a request or the conversation; a config-gated
  curator archives unused provenance-backed skills (never deletes).
  Mechanisms borrowed from hermes-agent; ruling: `design/skills.md` →
  Self-authoring, /learn, curator.

Acceptance: a corrected interpretation changes subsequent behavior with visible
provenance; project isolation holds across recall and retention; memory-off
does not disable explicit work state or follow-through.

## Longer Horizon: Native Work Through Pi-Durable — superseded (#609)

The Pi Durable runtime this section planned around is removed; native
`agent` children and `delegate` on T3 Code cover the same ground. Grow
roles, assignments, histories, budgets, and execution workflows from real
repeated work. Keep
the delegate bridge useful; do not retire capable
coding harnesses merely to make the architecture look finished.

Do not build the entire managed workforce before proving the next outcome.
Do not confuse "native" with cheaper subscription economics or retire capable
coding harnesses merely to make the architecture look finished.

## Risk And Proof Discipline

The old Herdr identity race is gone with the transport (#608): T3
thread ids are stable identities and managed sends fence on them.
Verify the current boundary before
claiming stronger guarantees. A capability-advertised server-side identity
guard would address any residual race; more client reads do not. This targeted work can
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

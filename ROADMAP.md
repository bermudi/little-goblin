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
  originally defaulted to a model-waking Program every 15 minutes, up to 96 scheduled
  occurrences per active responsibility per day. That is not yet economical
  judgment about when follow-up is useful; the first stage-1 slice replaces
  that unconditional wake policy.
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

Issue builds now run through one lead delegation per issue (2026-11-09,
design/delegation.md → An issue build is one lead delegation). The pilot:
the operator hands over one real issue; goblin briefs a lead, and the
issue ends merged with a verifier verdict on the PR, without the operator
relaying between agents. Code now observes the closing PR, SHA-bound
verifier verdict and CI for responsibility-linked leads with explicit issue
identity (#406, design/delegation.md → PR readiness). Unchanged CI polls
do not wake a model; notes and operator-facing judgment still do. Existing
leads without that identity are not retroactively adopted. The full issue
pilot remains unverified.

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

First-slice boundary: follow-up policy on the existing linked Program,
with deterministic-clock tests and visible reason/due time. No full feed
redesign or model router bundled into it.

### First Slice: Implemented, Not Yet Piloted

The durable review plan now lives on the existing responsibility: purpose,
due time, kind, and stable dedupe token. `responsibility action=followup`
with `followup:{dueAt,reason}` sets a task-specific review. New follow-up
Programs check the plan every minute in code; existing/operator-edited cron
cadences are preserved. Ordinary ticks do not wake a model.

Absent a task-specific plan, a one-hour silence bound is an engineering
backstop, not a settled operator budget or a claim of task-specific judgment.
Meaningful observations still wake immediately and postpone only that silence
check; stable polling cannot postpone it, and explicit promises survive
developments. Due reviews enqueue before plan/cursor advancement. A stable
review token deduplicates retries across missed cron occurrences and restart;
compare-and-set prevents stale accounting from replacing a newer plan.

Corrections, changed status, and deliberate reattachment invalidate old
reviews. Timed inference is suppressed outside active status. The feed shows
the next effective check-in and purpose, derived from the plan plus the linked
Program, and reports missing/disabled/unscheduled follow-ups honestly.
Implementation contracts: `design/programs.md`, `design/app.md`.

Verification: 546 tests passed across 23 focused files (2,321 assertions),
covering responsibilities, observation, follow-up/recovery, wakes (including
the existing killed-process tests), Programs, scheduler, Herdr fixtures, tool
and HTTP boundaries, app feed, Attention, and module boundaries.
`bun run typecheck`, formatting of changed source/test files, and
`git diff --check` passed. Tests use real SQLite, explicit clock values,
fake edges, and restart/reconcile seams; this is not a killed-process proof
of the new plan write or a live project handover. The full suite was not
rerun for this slice; its previously recorded experimental failure remains
unresolved. No live prompts, deployment, service restart, or push.

### Second Slice: Reports And Derived Stages — Implemented, Not Yet Piloted

`responsibility action=report` states the work's state
(`progress|waiting|ready|blocked|failed|done|dropped`) with a reason, an
optional operator question, a `resumeWhen` for external waits, and evidence
items. Stored status is lifecycle only; whom the work waits for is derived
by one first-match stage function that the feed pill, Attention and the
scheduler share. `done` closes only when evidence covers every
completionEvidence entry; `dropped` closes "nothing to do". While the stage
waits on the operator the silence backstop is held (an explicit commitment
still fires); an operator correction answers the report. An app push, or Telegram when no device
gets it, reminds the operator without a model call, 4 hours after the report
and then daily. Ruling:
`design/programs.md` → Reports and stages (mechanisms borrowed from
dsh-superagent, cited there).

Verification: typecheck (both programs) passed. Full non-live suite on the
worktree: 5,313 pass, 91 skip, 2 fail — `boot.test.ts` "disabling after
polling starts" gets the by-design 500 because that fresh worktree had no
`app/dist` build; `subagents/mod.test.ts` "request recovery survives a
concurrent steer" timed out under full-suite load and passed alone. No live
prompts, deployment or restart.

### Third Slice: Pi-Durable Runs As Responsibility Workers — Implemented, Not Yet Piloted

`subagent start` takes an explicit `responsibility`; each settlement of a
linked run (`finish`, `ask_operator`, crash hold, failure) files one deduped
`worker` report before the notice wakes the conversation. A worker's claim
is goblin's to assess; its question goes to the operator unchanged. Ruling:
`design/programs.md` → Worker reports. The worker's own tools are
unchanged — no new evidence or `dropped` outcome on `finish` yet; add them
only if piloting shows goblin cannot assess from the result text.

### Fourth Slice: Queued Authority — Implemented, Not Yet Piloted

Scheduler, observer and mail-watcher developments stamp the
responsibility status, revision and (for observations) attachment
generation they acted on. The wake commit re-checks each stamp. A
development whose stamp lapsed since it was recorded (pause, close,
correction, detach, re-bind) is still delivered, framed as superseded
history, never as authority to act. Archive stays visibility-only:
pausing the responsibility is what stops work. Ruling:
`design/programs.md` → Queued authority. The responsibility store now
opens before the wake dispatcher, so the boot pump re-checks too.

Verification: typecheck passed on both programs. Focused suites (wakes,
scheduler, responsibilities, mail watcher, module boundaries, app
responsibilities, boot): 345 passed, 1 failed. The failure is the
by-design `app/dist` 500 in `boot.test.ts` on this unbuilt worktree.

Still open in stage 1: a useful real-world pilot. Already enqueued
developments remain historical facts. This does not introduce generic wake
revocation or strengthen the accepted Herdr send race.

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

Briefly deployed to g7 as release 7a0f8a6 (2026-11-06, 00:48-03:04 CST), then
replaced by a release from main. The schema migrations stayed on the live store
(work_events authority/superseded, report purpose/artifacts). Prod stays on main:
pilot after this merges and is released. No real handover has run yet.

First combined pilot: explicit handover, a real development or blocker, an
operator correction, a controlled restart, and evidenced completion. Separately
exercise failure paths in isolation. Live prompts, service restarts, and other
consequential operations retain their normal authorization requirements.

### First Slice: Outcome Posts — Implemented, Not Yet Piloted

The feed separates outcomes from activity. Responsibility reports are
served as posts, newest first and bounded. Each post says whose word it
is: goblin-assessed, a worker claim not yet reviewed, a reviewed worker
claim, or a migrated status. A post an operator correction has overtaken
is dimmed. The newest post shows under the collapsed pill with **Open
conversation**, so the result or the decision needed reads without
opening every item. Check-ins and observations stay in History. Ruling:
`design/app.md` → Outcome posts.

Verification: typecheck (both programs) passed. Full suite: 5,331 passed,
91 skipped, 1 failed. The failure is the by-design `app/dist` 500 in
`boot.test.ts` on this unbuilt worktree. Client behaviour is pinned in
happy-dom tests. It has not been seen in a real browser yet: builds belong
on CI, and the mobile layout still needs a look.

The cross-project feed moved from the Projects index to Attention, under
the open decisions: one place to watch, with the badge the rail and tab
bar already show. Project pages keep their own feed.

Typed posts: a report's `purpose` (status, finding, draft or change)
labels what it carries, and `artifacts` link what it produced. A finished
run's exported files become artifacts. The `responsibility` tool
describes both. Ruling: `design/app.md` → Outcome posts → Typed posts.

Browser check (2026-11-04): the Vite dev server (no production build)
against a stub backend serving the real feed read model over seeded
stores, headless at 1280px and 390px. Seeded: a worker claim, a question,
a draft with a link and a path, a finding with an unbroken 150-character
ref, a post overtaken by a correction, a paused item, and an empty
feed. Nothing overflowed at 390px. Two fixes came out of it: a row said
"no activity" while carrying a post filed seconds earlier (freshness now
counts reports), and "Open conversation" wrapped onto two lines on a
phone. The stub's non-feed endpoints were canned, so this is a layout and
state check, not proof against the live backend. The combined pilot
remains.

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

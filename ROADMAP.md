# The Way Forward

This is the sequence for proving the experience in [DIRECTION.md](DIRECTION.md)
within [the scope set in AGENTS.md](AGENTS.md#goblin-is-a-loop-with-tools-and-connectors-thats-it).
It does not authorize implementation, live work, or deployment.

Source baseline: `5cb2c489` on `main`, after the T3 Code issue handover
landed. This is a checkout inspection, not a check of the live release.
For source owners, start at [DESIGN.md](DESIGN.md).

## Next Acceptance Target: Carry One Project Without Babysitting

The operator hands over useful existing work once, can leave it alone, and
returns to understand what moved, what needs judgment, and what is evidenced.
Goblin does not spend the allowance saying "still working," manufacture
completion, or leave the operator to reconstruct progress from machinery.

Use one real handover with the tools that already exist. Look for a useful
development or blocker, a correction that reaches the right work, and a
result with evidence. Check recovery in isolation. Reuse any recorded pilot
evidence before asking to run one. No full live pilot is evidenced here.

A GitHub issue is one candidate, not a workflow Goblin must implement.
The linked issue can supply the closing PR, its head commit, verifier
comment, and CI status. What those facts mean for the work comes from the
operator and their skills. If the example includes merging, that still
requires the operator's green light.

## 1. Make Follow-Through Deliberate

**Shipped:** The `responsibility` tool stores a next check with a due time
and reason. The scheduler checks without calling a model on every tick.
Due checks use a stable identity so retries do not queue the same check
twice. T3 Code observations and GitHub polling can report changes without
model polling. Linked workers can return claims separately from Goblin's
assessment. See [scheduling and reports](design/programs.md) and
[linked workers](design/agents.md#linked-workers-one-contract-across-transports-2026-11-19-779).

**Prove next:** A changed fact or a due check reaches the conversation once
without a model call for every unchanged poll. The operator can see why a
check is due, what is waiting, and what changed. Pausing, cancelling, and
correcting take effect even if an action was queued: old observations remain
visible as history, not permission. Archiving stays a visibility control.
An adopted workspace stays open, and an uncertain send is not replayed.

### Existing Policy To Separate From The Tools

These are conflicts or limits in current code, not work this pass implements.
Do not extend them as defaults for new kinds of work.

- **Issue handover.** The [tool](src/agent/tools/responsibility.ts) tells
  Goblin to launch immediately. [`inner-loop.ts`](src/inner-loop.ts) supplies
  a default model and branch name and adds draft PR and verifier instructions.
  The [watcher](src/responsibility-readiness.ts) uses that verdict format to
  classify PR evidence. Keep authorized T3 Code operations and GitHub
  observation. Leave when to start, model and branch choice, and required
  review to the operator or their skill. A matching verdict and green CI
  are evidence, not merge approval.
- **Completion.** [`report done`](src/responsibilities.ts) requires evidence
  entries matching the saved `completionEvidence` list, which can be empty.
  `dropped` requires an evidence item. The store checks the fields, not
  whether the outcome happened. Keep the ability to record an outcome and
  its evidence. Leave finish criteria and verification to the operator or
  skill. The roadmap does not require a universal completion report.
- **Follow-up timing.** The [scheduler](src/scheduler.ts) holds its
  [one-hour fallback](src/responsibility-followup.ts) when work waits for the
  operator; [reminders](src/reminders/policy.ts) separately nudge after four
  hours and then daily. Keep reliable timers, deduplication, delivery, and
  authority checks. A stall backstop is not a task review plan. Leave task
  checkpoints and when to nudge to the operator or skill. The fixed reminder
  cadence is shipped policy, not a reason to add more timing rules.

## 2. Bring Back Outcomes, Not Just Activity

**Shipped:** Project pages and the app's Attention view show
[outcome posts](design/app.md#outcome-posts-ruling-2026-11-02) based on
existing reports. Posts preserve evidence, artifacts, and who made or
assessed a claim. Routine observations stay in history. A post opens its
coordination conversation rather than creating a second comment thread.

**Prove next:** On desktop and mobile, the operator can find what changed
and what needs a decision without opening every conversation. Reload keeps
the result and its evidence. A correction reaches the right work and does
not erase the prior claim. Check empty, stale, and failed states against
the real backend; the earlier browser check used a stub.

**Possible gap:** If Attention is not a useful front door in the pilot,
improve how the app presents the same saved results. Do not create another
inbox or task database. Give Goblin a way to surface a result without making
the app decide which findings are important or impose a review before posting.

## 3. Add Useful Cheap Capacity

**Shipped:** An [agent type](GLOSSARY.md#glossary) can name a configured
model and a restricted tool list for an `agent` child. The existing runtime
caps and queues children. A child interrupted by restart reports failure;
it does not resume a half-finished tool call. See
[agent execution and limits](design/agents.md#limits).

**Prove next:** Use a model the operator explicitly configured for a small
assignment, such as a sourced comparison. The operator can see the worker's
result, its source, and what was checked. If capacity runs out or a run breaks,
the assignment stays visible and the failure is clear, without silent paid
substitution or unbounded retries.

**Possible gap:** Fix missing limits, tool access, or failure reporting if the
trial exposes them. Choosing the assignment and assessing its evidence stay
in the conversation or skill. No research pipeline or model router is planned
for this trial.

## 4. Close The Steering And Memory Loops

These tracks do not block the first pilot.

- **Feedback:** [Reply ratings](src/reply-ratings.ts) are record-only.
  Make feedback available with the item it refers to and keep corrections
  visible. The agent interprets the feedback in context; a downvote is not
  code-level permission to set a lasting preference. Prove that an explicit
  correction changes a later answer and that the operator can see why.
- **Memory:** Projects currently support [shared/off](src/projects.ts)
  memory, not separate memory. When adding the separate boundary, prove
  that saving and retrieving memories stay isolated and that turning
  memory off does not erase assignments. Expose what memory reached a
  reply; the [latest request view](src/window-capture.ts) is not a history
  of what reached every reply.
- **Skills:** Use the existing [`/learn` and proposal flow](design/skills.md#self-authoring-learn-curator-ruling-2026-11-16-operator-decisions)
  for lessons about how to do a task. Prove that an approved change reaches
  the next relevant run and that the operator can inspect what changed.

## Risk And Proof Discipline

T3 Code uses stable thread IDs, rather than the old Herdr terminal identity
path. [Managed sends](src/responsibility-service.ts) re-check permission
before dispatch. Do not treat a client-side check as an atomic server-side
guarantee, and do not retry if delivery is uncertain.

Keep three claims separate: shipped in source, tested in isolation, and
demonstrated on useful live work. Use isolated contract checks for external
interfaces; a fixture does not prove the upstream interface. Live model runs,
service restarts, and deployment keep their normal authorization requirements.

### Recorded Checks

These are historical checks, not fresh results on the baseline above:

- Follow-up scheduling and recovery passed 546 focused tests and typecheck.
  The suite used real SQLite and controlled clocks; it did not prove recovery
  from process death during the new plan write itself.
- Reports, queued authority, and the feed passed typecheck. Their historical
  runs were not all green: `boot.test.ts` got the expected missing-app-build
  500 in an unbuilt checkout, and the now-retired Pi Durable recovery test
  timed out in a full run but passed alone. An earlier full run also failed
  an experimental Pi approval retry test that passed alone.
- The feed layout was checked at 1280px and 390px on 2026-11-04 using
  the real feed data projection with a stub backend. A feed slice was
  briefly live as release `7a0f8a6` on 2026-11-06 and then replaced.
  Neither proves a real handover or the current live version.

## Resume And Maintain

Start with the next unproven target. Inspect the source since the baseline
and use any existing pilot evidence. If work falls short, identify the
missing tool, connector, or runtime behavior before proposing code. If the
tools already do the job, improve the skill or leave the choice to the
operator. Record what was actually verified.

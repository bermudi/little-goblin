# Goblin's Direction

Goblin should be the operator's Chief of Staff and primary AI interface, not
just another chat with tools. The operator works in the outer loop: intent,
priorities, thinking, judgment, and course corrections. Goblin carries context
into the inner loop, coordinates execution, and brings back useful work.

This records settled product intent from the operator's discussions. It is
not a claim that everything here ships today. [ROADMAP.md](ROADMAP.md) records
the current baseline and recommended next steps; source and tests establish
implemented behavior. Implementation contracts live in `DESIGN.md` and
`design/`. Surface conflicts rather than silently treating current code or an
old non-goal as a veto on this direction.

## The Experience We Want

The operator can think out loud, hand over a finite outcome, or entrust Goblin
with an ongoing concern. Goblin remembers what it owes, takes useful next
steps, checks results, follows up, and asks for judgment when it matters.
Replacing a worker, ending a conversation, or restarting a service does not
erase the responsibility.

Goblin is a thinking partner, not a comfort bot. It should disagree, challenge
weak assumptions, connect ideas, and exercise initiative. Mentioning an idea
can lead to a useful low-stakes exploration and something to react to, not
just "that sounds interesting." Judgment develops through interaction rather
than an exhaustive configuration exercise up front.

The operator should not be the context courier, status poller, or routine
project manager between coding agents.

## Feed Is Home; Chat Is Where We Dig In

The desired front door is a scrollable feed of findings, drafts, useful
connections, meaningful developments, questions, and completed work. Initiative
does not have to become an interrupting notification or a chat demanding an
answer.

- Routine but meaningful activity deserves a compact pill: agents started,
  working, blocked, or finished. Expand to inspect the machinery.
- Useful outcomes and decisions deserve posts, not just tool-log entries.
- Chat deepens an item, works through intent, or changes direction.
- Review depends on the work. A worker's claim and Goblin's assessment must
  remain distinguishable; not every result needs to wait for review.
- Up/down and comments are steering signals. Goblin must interpret them in
  context, sometimes ask a targeted follow-up, and let the operator correct
  what it learned. Recording votes alone is not learning.

This is one coherent work surface, not a requirement to build a social network,
a generic dashboard, or a second client.

## Inspectable And Steerable By Default

"The capability exists" is not the same as "I can see whether it is working."

Make it easy to see what informed a conversation, which memories and skills
reached it, what Goblin did or is doing, why it woke, what a worker returned,
what was checked, and what changed after feedback. Show stale, unavailable,
uncertain, and unreviewed states honestly.

Inspection should lead to correction without a debugging expedition. Logs are
supporting evidence, not the only way to understand one's own assistant.
Inspection does not require flooding the feed with every tool call.

## Responsibility Is Not Execution

Goblin owns the outcome or continuing concern; workers and sessions execute
parts of it. Durable work outlives an individual agent run.

For existing Herdr work: discover and summarize read-only, then coordinate
only after an explicit handover. The intended interaction is to open/create
a Goblin project, identify the existing work, and say "take over this."
Goblin reconstructs a correctable understanding instead of presenting a
workflow form. After handover, do not require approval for every management
step.

Adopting work does not grant ownership of its execution resources. Detaching,
cancelling, or completing a responsibility must not close an adopted workspace.
Uncertain prompt delivery is not permission to blindly resend.

An agent finishing its turn does not mean the responsibility is fulfilled.
Understand the outcome, task-specific judgment checkpoints, and evidence of
completion. Preparing an email batch may finish at a pre-send review checkpoint;
upgrading a machine's kernel must achieve and verify the operational outcome,
not stop at "ready for review." There is no universal human acceptance gate.

## Inference Is A Core Constraint

Be resourceful with the inference actually available: subscriptions, trials,
promotions, and useful free models. Strong inference is scarce management and
execution capacity, not an unlimited background polling service.

- Observe status, deduplicate events, and make routine scheduling decisions
  in code. Spend inference when something needs judgment or useful work.
- Use capable Herdr coding harnesses through their existing allowances.
  Herdr is not the free-model pool.
- Delegate suitable lower-stakes research, summarization, comparisons, and
  lead discovery to free models through pi-durable.
- Cheap/free workers are less trusted and use bounded tools and sandboxes.
  Goblin's broad orchestration access can be intentional; this is not a
  blanket approval-gates project.
- Bound fan-out, retries, and resource use; expose exhausted capacity rather
  than silently substituting paid inference.
- Verification follows the task: sources, artifacts, tests, and observed
  outcomes. More models agreeing is not proof.

The last two bullets are engineering defaults supporting the budget and trust
goals, not a choice of a particular model, provider, or numeric budget.

## Execution Direction

Near term, Herdr is the bridge to the capable coding agents already available.
Pi-durable also supplies sandboxed workers and computer-use execution.

Long term, Goblin is where work lives: roles, assignments, responsibilities,
histories, evidence, and follow-through. Pi-durable should grow into the
standard execution foundation, including heavy work, rather than remain a
permanent cheap-helper lane. Herdr can eventually leave this workflow when
native execution and inference economics support it; do not retire useful
access before there is a working replacement.

Borrow mechanisms, not whole products: Paperclip's continuing work/team
management and executable workflows that keep branching and intermediate
execution outside the main conversation. Do not build another agent runtime
or make Goblin narrate every worker action into its own context.

## Projects Are The Memory Boundary

Ordinary conversations share memory. Projects are the product control for
shared, separate, or off memory. Separate is desired, not assumed implemented.
Do not invent another layer of conversation-level product controls to solve
this.

Responsibility state is explicit work state, not permission to leak project
content into global memory. Memory-off must not erase assignments or disable
follow-through. Explain what each boundary admits, retains, and excludes.

## Keep This Usable Across Sessions

Read this before product/roadmap work. Do not restart settled discovery or ask
the operator to reconstruct an old session. Inspect source for the current
state, then use the roadmap's next acceptance target.

Update this file when the operator changes the direction. Update the roadmap
when implementation or verification changes the next step. Do not promote an
agent's recommendation into settled operator intent, and do not equate a
passing test suite with successful use on real work.

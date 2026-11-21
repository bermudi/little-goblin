# Goblin's Direction

Goblin should be the operator's primary AI interface. The operator sets intent
and priorities and makes judgment calls. Goblin carries context, can act on work
the operator entrusts to it, and brings back useful results.

This records settled product intent from the operator's discussions. It is
not a claim that everything here ships today. [ROADMAP.md](ROADMAP.md) records
the current baseline and recommended next steps; source and tests establish
implemented behavior. [DESIGN.md](DESIGN.md) points to the code and explains
design choices. Apply [the governing scope rule in AGENTS.md](AGENTS.md#goblin-is-a-loop-with-tools-and-connectors-thats-it)
when reading these goals. Surface conflicts rather than turning a desired
outcome into a required workflow.

## The Experience We Want

The operator can think out loud, hand over a finite outcome, or entrust Goblin
with an ongoing concern. Goblin remembers what it owes, takes useful next
steps, checks results, follows up, and asks for judgment when it matters.
Replacing a worker, ending a conversation, or restarting a service does not
erase what Goblin owes.

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

- Show routine activity in compact, expandable rows. Give Goblin a way to
  share useful outcomes and decisions without promoting every event to a post.
- Chat deepens an item, works through intent, or changes direction.
- Review depends on the work. A worker's claim and Goblin's assessment must
  remain distinguishable; not every result needs to wait for review.
- Up/down and comments are steering signals. Keep their context so Goblin can
  act on feedback and the operator can correct a mistaken interpretation.
  Recording votes alone is not learning.

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

When the operator hands over work, Goblin keeps a
[responsibility](GLOSSARY.md#glossary): a saved record of what it owes.
Workers and sessions can execute parts of it. The record outlives an
individual agent run.

These are the two concepts: what Goblin owes, and who executes a piece of it
(operator, 2026-11-06). What the model sees should follow them, not the
plumbing underneath. The operator suspects overlapping tools hurt the model's
performance; this is not measured yet. Judge the tools by what makes sense for
a capable agent, not by usage, because much of this code is new.

Goblin can discover and summarize existing T3 Code threads read-only. To grant
coordination, the operator can say "take over this" in a project and correct
Goblin's understanding in conversation. Handover grants coordination and
follow-up for that work, not standing authority. A separate scheduled or
mail-triggered job still needs the operator's yes (operator, 2026-11-19).
Actions within the grant need not ask again.

Adopting work does not grant ownership of its execution resources. Detaching,
cancelling, or completing a responsibility must not close an adopted workspace.
Uncertain prompt delivery is not permission to blindly resend.

An agent finishing its turn does not mean the work is done. The operator and
skills set what to check, when to check again, and when to ask for judgment.
Preparing an email batch may finish at pre-send review; upgrading a machine's
kernel may finish only after verifying the machine runs the new kernel. These
are examples, not stages every task must pass.

Repo work stays in that repo's GitHub Issues; Goblin's responsibilities record
what it owes the operator and can point at them (operator, 2026-11-06). Code
reaches main only after Goblin delivers evidence it works and a way to try it,
and the operator gives the green light.

## Inference Is A Core Constraint

Be resourceful with the inference actually available: subscriptions, trials,
promotions, and useful free models. Strong inference is scarce management and
execution capacity, not an unlimited background polling service.

- The Claude Code subscription is a first-class option (2026-10-27).
  Goblin's [Claude Code engine](design/model.md) uses the subscription,
  not API credits.
- Observe external status, deduplicate events, and deliver scheduled triggers
  without using a model to poll. Spend inference when there is judgment or
  useful work to do.
- Use capable coding harnesses through their existing allowances, when the
  operator asks for one. Harness runs are not the free-model pool.
- Make configured free models available for bounded work through `agent`.
  Research and summarization are examples of work a skill can assign, not
  rules for choosing a model.
- Cheap/free workers are less trusted and use bounded tools and sandboxes.
  Goblin's broad orchestration access can be intentional; this is not a
  blanket approval-gates project.
- Bound fan-out, retries, and resource use; expose exhausted capacity rather
  than silently substituting paid inference.
- Verification follows the task: sources, artifacts, tests, and observed
  outcomes. More models agreeing is not proof.

These goals do not choose a new model, provider, or numeric budget.

## Execution Direction

Goblin has real [subagents](GLOSSARY.md#glossary), like Claude Code's
(operator, 2026-11-16). The `agent` tool runs them on Goblin's own runtime
with access to the same model providers, including the Claude subscription.
`delegate` runs an external coding agent only when the operator names one.
Goblin coordinates handed-over T3 Code threads through the connector, not
by rebuilding the operator's desk inside Goblin. See
[agent design](design/agents.md) for the two tools and their transports.

Keep assignments, results, and evidence accessible without replaying every
worker action into the main conversation. Do not retire a useful connector
before there is a working replacement.

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

# Goblin's Direction

Goblin should be the operator's Chief of Staff and primary AI interface, not
just another chat with tools. The operator works in the outer loop: intent,
priorities, thinking, judgment, and course corrections. Goblin carries context
into the inner loop, coordinates execution, and brings back useful work.

This records settled product intent from the operator's discussions. It is
not a claim that everything here ships today. [ROADMAP.md](ROADMAP.md) records
the current baseline and recommended next steps; source and tests establish
implemented behavior. [DESIGN.md](DESIGN.md) points to the code and explains
design choices. Surface conflicts rather than silently treating current code
or an old non-goal as a veto on this direction.

## The Experience We Want

The operator can think out loud, hand over a finite outcome, or entrust Goblin
with an ongoing concern. Goblin remembers what it owes, takes useful next
steps, checks results, follows up, and asks for judgment when it matters.
Replacing a worker, ending a conversation, or restarting a service does not
erase what it owes.

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

## A Loop With Tools And Connectors

Goblin is a loop with tools and connectors; that's it (operator,
2026-11-21, #842, #844). Code observes outside facts, delivers them and
runs tools. Code does not decide how work gets done: no work states,
evidence rules, handover keys, follow-up clocks, build recipes or PR
watchers. Goblin still owns the outcome or continuing concern, and
remembers what it owes in its own notes, the way its skills say.

The general mechanism code offers is a wake: "wake me when this changes",
for a T3 Code thread, a GitHub PR or a time. Goblin decides what a wake
means and what to do next. Schedules, webhooks and mail watches
(Programs) also wake the loop; a new Program still needs the operator's
yes (operator, 2026-11-19).

The operator suspects overlapping tools hurt the model's performance;
this is not measured yet. Judge the tools by what makes sense for a
capable agent, not by usage. A tool that only wraps a CLI Goblin can
already run through `bash` is overlap: Goblin drives T3 Code with the
`t3` CLI (operator, 2026-11-21).

Goblin's features stay separate from the operator's own workflow with AI
agents (operator, 2026-11-19). How the operator builds, reviews and
verifies work, which agent runs which job, and when to take over an
existing thread live in skills; Goblin's code names no particular
workflow, skill, agent or verdict format. Every `delegate` call names its
harness.

These stay judgment, written in skills, not rules in code: an agent
finishing its turn does not mean the work is done; taking over someone's
T3 Code thread waits for the operator's handover; uncertain prompt
delivery is not permission to blindly resend.

Repo work stays in that repo's GitHub Issues (operator, 2026-11-06). Code
reaches main only after Goblin delivers evidence it works and a way to try
it, and the operator gives the green light.

## Inference Is A Core Constraint

Be resourceful with the inference actually available: subscriptions, trials,
promotions, and useful free models. Strong inference is scarce management and
execution capacity, not an unlimited background polling service.

- The Claude Code subscription is a first-class lane (2026-10-27):
      Anthropic conversations burn the OAuth subscription, not API credits
      (goblin's claude-code engine; `design/model.md` → The claude-code
      engine). Subscriptions already paid for are the cheapest inference
      there is.

- Observe status, deduplicate events, and make routine scheduling decisions
  in code. Spend inference when something needs judgment or useful work.
- Use capable coding harnesses through their existing allowances, when the
  operator asks for one. Harness runs are not the free-model pool.
- Delegate suitable lower-stakes research, summarization, comparisons, and
  lead discovery to free models through native agents.
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

Goblin has real subagents, like Claude Code's (operator, 2026-11-16): one
`agent` tool whose children run on Goblin's own runtime and model layer, so
every inference lane (including the Claude subscription) is available to
them. External harnesses (codex, opencode, …) run only when the operator asks
for one, through `delegate`. The operator works in T3 Code, not the old
operator-desk Herdr tool. Per the operator's 2026-11-18 direction,
`delegate` runs named harnesses on pinned herdr-core (`hc`), with Goblin
making the binary and lifecycle hooks available at execution. Handover
stays on T3 Code, through its CLI (design/agents.md, design/delegation.md).

Long term, Goblin is where work lives: histories, evidence, and
follow-through, carried by the loop, its notes and its skills. Native agents grow into the standard
execution foundation, including heavy work. Do not retire useful access
before there is a working replacement.

Borrow mechanisms, not whole products: Paperclip's continuing work/team
management and executable workflows that keep branching and intermediate
execution outside the main conversation. Do not build another agent runtime
or make Goblin narrate every worker action into its own context.

## Projects Are The Memory Boundary

Ordinary conversations share memory. Projects are the product control for
shared, separate, or off memory. Separate is desired, not assumed implemented.
Do not invent another layer of conversation-level product controls to solve
this.

Watches and notes are explicit work state, not permission to leak project
content into global memory. Memory-off must not erase what Goblin owes or
disable follow-through. Explain what each boundary admits, retains, and excludes.

## Keep This Usable Across Sessions

Read this before product/roadmap work. Do not restart settled discovery or ask
the operator to reconstruct an old session. Inspect source for the current
state, then use the roadmap's next acceptance target.

Update this file when the operator changes the direction. Update the roadmap
when implementation or verification changes the next step. Do not promote an
agent's recommendation into settled operator intent, and do not equate a
passing test suite with successful use on real work.

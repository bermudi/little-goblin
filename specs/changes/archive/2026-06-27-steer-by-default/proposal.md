## Motivation

When a user sends a second message to a busy goblin session, that message sits in a per-session promise queue (`promptQueues` in `bot.ts`) until the in-flight turn fully settles. Only then does it reach `AgentRunner.prompt`, by which point `isStreaming` is always false and the runner takes the `sendUserMessage` branch. The `followUp` (steer) branch in `AgentRunner.prompt` — which the agent spec explicitly mandates ("use `followUp`, MUST NOT implement its own queue") — is dead code on the Telegram path.

This is the wrong default for a conversational agent. Steer lets the user redirect, refine, or augment a running turn in-place: "actually use the other file", "stop, that's enough, summarize what you have", "also handle the empty-string case". The model sees the new message mid-turn and incorporates it. Queuing forces the user to wait for a complete (possibly wrong) answer before they can correct course, then pays for a second full turn to undo the first.

The current queue exists for one stated reason: "protect `AgentRunner`'s per-turn callback state and preserve message order." That rationale is an artifact of `prompt()`'s shape — it unconditionally overwrites `this.callbacks` and `this.accumulatedText` at the top of every call. Steer does not need to touch those fields; the in-flight turn's `MessageBuffer` keeps streaming and the new user text folds into the running turn's context via `session.followUp`. The clobber problem only arises because `prompt()` always resets state, not because steer is fundamentally unsafe.

There are legitimate cases where the user wants serialize-and-wait: "answer this after you finish", "remember to also do X when you're done". These should be opt-in via an explicit `/queue` command, not the default.

The canon specs are also in conflict: `agent/spec.md` mandates `followUp` with no queue, while `orchestration/spec.md` mandates same-session serialization. The code follows orchestration and violates agent. This change reconciles both.

## Scope

### Steer as the default for in-flight messages

When a non-command message arrives for a session whose runner is currently streaming, the bot SHALL dispatch it via a new `AgentRunner.followUp(content)` method that calls pi's `AgentSession.followUp()` without resetting `this.callbacks` or `this.accumulatedText`. The in-flight `MessageBuffer` continues to render the running turn; the new user text is injected into the model's context mid-turn. No new status line, no new response bubble is created for the injection itself — the model's subsequent output flows through the existing buffer.

### `/queue` command for explicit serialization

A new `/queue <text>` command SHALL enqueue the supplied text via the existing `promptQueues` chain so it runs as a fresh turn only after the current turn (and any prior queued work) settles. This preserves the serialize-and-wait behavior for users who want it, as an explicit opt-in. `/queue` is NOT cancel-capable — it does not interrupt the running turn; it appends to it.

### Reconcile the canon specs

- `agent/spec.md`: the existing "In-flight prompts use pi's followUp queueing" requirement is MODIFIED to describe the new `followUp()` method on `AgentRunner` and clarify that the runner does not own a queue; the bot layer decides steer-vs-queue.
- `orchestration/spec.md`: the "Agent turns do not block unrelated updates" requirement is MODIFIED so that same-session work is steered into the running turn by default, with serialization only for `/queue` and for ordering non-overlapping turns (when the runner is idle). The "Same-session work remains ordered" scenario is replaced with steer semantics.
- `commands/spec.md`: ADDED requirements for the `/queue` command and its registration in the command surface and `/help` output.

### Capabilities affected

- **agent** — new `followUp()` method, MODIFIED in-flight prompt requirement.
- **orchestration** — MODIFIED serialization requirement to steer-by-default.
- **commands** — ADDED `/queue` command.

## Non-Goals

- **No queue introspection or management commands.** No `/queued`, `/clear-queue`, or queue listing. The queue is at most one item deep in practice (steer handles the rest); if it grows, the user can `/cancel` and resend.
- **No steer for media-only messages.** Photos, documents, and voice messages still go through `schedulePrompt` and serialize behind a running turn. Steer is text-only because `followUp` injects text into the running turn's context; multimodal mid-turn injection is a separate concern. (A photo sent while busy will queue and run after the turn settles — acceptable, and the user can `/cancel` first if they want it sooner.)
- **No changes to cancel-capable command semantics.** `/cancel`, `/new`, `/archive`, `/debug`, `/compact`, `/name`, `/resume`, `/model` still abort the running turn before executing. Steer does not change the interrupt cascade.
- **No per-message steer/queue toggle beyond `/queue`.** No config flag, no inline reply hint. The default is steer; the only opt-out is `/queue`.
- **No change to subagent dispatch.** Subagents have their own runner lifecycle; this change is main-agent-only.
- **No mid-turn status indicator for steered messages.** The user's steered text is not echoed back by goblin; the model's response to it streams through the existing buffer. A future change could add a "steered" reaction on the user's message for feedback.

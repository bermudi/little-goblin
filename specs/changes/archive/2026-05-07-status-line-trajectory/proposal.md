# Status line shows the full turn trajectory

## Motivation

The status line is a destructive 3-phase machine: `🤔 thinking…` → `🔧 working: <tools>` → `✅ <tools>`. Each transition replaces the previous render, so by the time the turn settles to `✅ spawn_subagent` the user has lost the prior phases — no record that the agent thought first, no per-tool boundaries, no sense of trajectory. For multi-tool turns this is worse: `🔧 working: read, bash, write` collapses an entire timeline into one comma-joined blob, indistinguishable from a single huge call.

Goblin lives in Telegram, where the status line is the primary "what is the agent doing right now" affordance. Surrendering that signal to the resting state makes long turns feel opaque. The trajectory exists in `events.jsonl`, but the user is not going to grep a log file to understand a 5-second interaction.

This change replaces the coarse phase machine with a per-tool ordered render: the thinking header persists for the turn, and each visible tool earns its own slot that transitions in place from `🔧 <name>` → `✅ <name>` / `❌ <name>`. Repeat invocations of the same tool fold into a count (`✅ read ×3`). Visibility levels keep their existing role of filtering *which* tools surface, and each level grows two new knobs (cap, timing) to keep the message bounded.

## Scope

**Affected capability:** `message-buffer` only. No changes to agent, telegram middleware, sessions, subagents, or config schema beyond the visibility table.

**Behavior changes:**

- `MessageBuffer.buildStatusLine` returns a multi-line string instead of a single line. Line 1 is `🤔 thinking…` (header, persists for the whole turn). Subsequent lines are per-tool slots in observation order.
- Internal state replaces `toolsObserved: string[]` + `toolsRunning: Set<string>` with a single `Map<toolName, ToolSlot>` where `ToolSlot` carries `{ runningCount, completedCount, startedAt, endedAt?, lastCompletedError }`. The display count `×N` reflects total invocations observed (running + completed). Parallel invocations of the same tool keep the slot in `running` until `runningCount` reaches zero.
- The phase machine (`thinking | working | done`) and the `StatusPhase` type are removed entirely. The header is a constant string for the turn; per-tool transitions are independent of any global phase.
- Repeat invocations of the same tool name (sequential or parallel) increment the slot's running/completed counters rather than appending a new line.
- A line cap per visibility level: when slot count exceeds the cap, the oldest *completed* slots are folded into a `… +N earlier` footer line. Running slots are never elided.
- `verbose` and `debug` levels render per-tool elapsed time as `(N.Ns)` once a slot transitions to `ok` / `err`. Re-entry resets the timer; the suffix measures the *most recent* invocation, not cumulative time.
- Zero-tool turns now explicitly rest on the header (`🤔 thinking…`) instead of the prior under-defined "edit-to-empty or leave-as-is" behavior.
- The placeholder, status-frozen, force-flush, throttle, and chat-action behaviors are unchanged.

**Visibility table** gains two columns:

| Level | Tools | Cap (slot lines) | Timing |
|---|---|---|---|
| `none` | — | — | — |
| `minimal` | bash, write, edit, spawn_subagent | 8 | no |
| `standard` | + read, grep | 12 | no |
| `verbose` | + revive_subagent, list_subagents | 20 | yes |
| `debug` | * | 25 | yes |

The cap counts slot lines only; the optional `… +N earlier` footer is rendered in addition and is not counted toward the cap.

**Tests:** [src/tg/buffer.test.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.test.ts) needs broad updates — most assertions on the exact strings `"🤔 thinking…"`, `"🔧 working: <names>"`, `"✅ <names>"` change. New cases cover folding, per-level cap, timing render for verbose/debug, and the additive trajectory.

## Non-Goals

- **No new visibility level.** The five existing levels stay; only their behavior on the status line is enriched.
- **No config knob for the new behavior.** Additive trajectory is unconditional. There is no `additive: bool` toggle and no migration path for the old format — single user, single homelab, ship the new shape.
- **No streaming arg/preview text in the status line.** Slots are name + state + (optional) count + (optional) timing. Tool input rendering is out of scope.
- **No spinner animation.** The status throttle is still ~1/sec; we do not animate `🔧` between frames.
- **No structural change to the response message.** Text streaming, 4096 rollover, and 20 KB file escape behavior are untouched.
- **No event-log integration.** `events.jsonl` already records the trajectory; this change is purely about the live Telegram render.
- **No change to `onAgentEnd` semantics, status-frozen guarantee, or the eager-placeholder-before-response ordering.**

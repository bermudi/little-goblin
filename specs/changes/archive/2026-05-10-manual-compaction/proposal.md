# manual-compaction

## Motivation

pi's `AgentSession` has a `compact()` method that summarizes and discards old conversation entries to reclaim context window space. Auto-compaction already fires at `agent_end` when the token budget is exceeded. But there's no way to trigger compaction manually from Telegram. A user in a deep session who expects more tools ahead might want to compact proactively before hitting the limit. Or they might want to compact with custom instructions ("focus on the schema decisions").

The plumbing is already there — `AgentSession.compact()` and `compaction_start`/`compaction_end` events — but goblin doesn't bridge it. Adding a `/compact` command is a ~20-line change that wires existing pi functionality through to Telegram.

## Scope

- **`/compact` command** in `bot.ts`, optional custom instructions as trailing text (`/compact focus on the database schema decisions`)
- **Cancel-capable** — interrupts any in-flight turn before compacting (same semantics as `/model`, `/debug`)
- **`AgentRunner.compact()`** delegates to `this.session?.compact()`
- **Status line updates** — `compaction_start` and `compaction_end` events are dispatched to `TurnCallbacks.onStatusUpdate` so the user sees "compacting…" while it runs
- **Reply message** — reports tokens freed and summary length after compaction completes

## Non-Goals

- **No auto-compaction controls** — pi's auto-compaction continues as-is; this change doesn't expose `autoCompactionEnabled` or `compactionSettings`
- **No compaction for subagents** — main session only
- **No compaction history or undo** — pi handles the session rewrite internally
- **No `compaction_start`/`compaction_end` logging toggle** — these events are already logged to `events.jsonl` by the existing "every event" logging rule

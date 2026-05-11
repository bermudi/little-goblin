# manual-compaction — Design

## Architecture

This change adds a thin bridge between Telegram (`/compact` command) and pi's existing `AgentSession.compact()` method. No new subsystems. Three files change:

```
bot.ts                     ← /compact command route + CANCEL_CAPABLE_COMMANDS
agent/mod.ts (AgentRunner) ← compact() delegation method
agent/events.ts            ← compaction_start / compaction_end → TurnCallbacks
```

### Data flow

```
User: "/compact focus on schema decisions"
  → bot.ts: message:text handler
    → parseCommand() → "/compact"
    → interruptAndCascade() (cancel-capable)
    → runner.compact("focus on schema decisions")
      → AgentRunner.compact()
        → init() (lazy, same as prompt())
        → session.compact("focus on schema decisions")
          → pi emits compaction_start → dispatchAgentEvent → onStatusUpdate("🗜 compacting…")
          → pi generates summary via LLM
          → pi rewrites session, emits compaction_end → dispatchAgentEvent → onStatusUpdate("compacted from ~42k tokens")
          → returns CompactionResult { summary, firstKeptEntryId, tokensBefore }
        ← CompactionResult
      ← CompactionResult
    → format reply: "Compacted from ~42K tokens."
  → ctx.reply(reply)
```

Note: because `/compact` is cancel-capable, it interrupts any in-flight turn before compacting. After the abort, `AgentRunner.callbacks` is null (the turn's `MessageBuffer` is gone). The `compaction_start`/`compaction_end` events fire but `dispatchAgentEvent` finds no callbacks — they're logged to `events.jsonl` only. The user-facing output is the command reply. If `/compact` runs while the agent is idle (no turn in progress), callbacks is also null and the same applies. This is fine — compaction events are observability, not core UX.

In the rare case where auto-compaction fires mid-turn (at `agent_end`), the `MessageBuffer` IS active and `onStatusUpdate` will surface the status. This is the only code path where the new `compaction_start`/`compaction_end` dispatch matters for user-facing UI.

## Decisions

### `/compact` is cancel-capable

**Chosen:** Add `"/compact"` to `CANCEL_CAPABLE_COMMANDS`.

**Why:** The user explicitly asked for compaction — they want the session cleaned up. An in-progress turn would be moot after compaction (old context is gone). Interrupting first is the safe default, consistent with `/model`, `/debug`, `/archive`, and `/new`.

**Alternative:** Non-cancel-capable — let it compact mid-stream. Rejected because:
- The compacted summary would include an incomplete turn state
- The in-progress stream would be orphaned (no context to continue from)
- pi might be in an undefined state if compact is called while streaming

### Compaction reply is the primary UX, not status line

**Chosen:** Format a reply from the returned `CompactionResult`. Status line events (`compaction_start`/`compaction_end`) are logged but not surfaced for command-initiated compaction (no active `MessageBuffer`).

**Why:** Command-initiated compaction happens outside a turn. There is no `MessageBuffer` to receive `onStatusUpdate` calls — the `AgentRunner.callbacks` field is null. The natural pattern for goblin commands is `ctx.reply()`.

**Constraint:** Auto-compaction (triggered by pi at `agent_end`) does have an active `MessageBuffer` and will surface through `onStatusUpdate`. This path is handled by the new `compaction_start`/`compaction_end` cases in `dispatchAgentEvent`.

### `AgentRunner.compact()` uses same lazy-init pattern as `prompt()`

**Chosen:** Call `init()` on first access, same as `prompt()` does.

**Why:** An `AgentRunner` may be constructed but never prompted (e.g. `/new` then `/compact` before any message). Calling `init()` ensures the pi `AgentSession` exists before we delegate. The pattern is already proven in `prompt()`.

### Error propagation: throw to caller

**Chosen:** `AgentRunner.compact()` does NOT catch pi's errors. The caller (`bot.ts`) handles formatting a user-facing reply.

**Why:** Consistent with other `AgentRunner` methods. The bot layer owns user-facing messaging; the runner layer is a thin wrapper. pi's error messages ("Nothing to compact (session too small).") are already user-suitable.

## File Changes

### `src/agent/events.ts` — handle compaction events in dispatchAgentEvent

Add two new cases in the `dispatchAgentEvent` switch, before the `// Ignore all other event types` comment:

```typescript
case "compaction_start":
  callbacks.onStatusUpdate("🗜 compacting…");
  break;

case "compaction_end": {
  const ce = event as { result?: { tokensBefore?: number } };
  const kt = ce.result?.tokensBefore
    ? `~${Math.round(ce.result.tokensBefore / 1000)}k`
    : "unknown";
  callbacks.onStatusUpdate(`compacted from ${kt} tokens`);
  break;
}
```

Affects: **Modified** requirement "Shared event dispatch function in agent/events.ts" (adds compaction_start / compaction_end handling).

### `src/agent/mod.ts` — add compact() method to AgentRunner

Add a public method after `abort()`:

```typescript
async compact(customInstructions?: string) {
  await this.init();
  if (!this.session) {
    throw new Error("Failed to initialize AgentSession");
  }
  return this.session.compact(customInstructions);
}
```

Affects: **Added** requirement "AgentRunner exposes compact()".

### `src/bot.ts` — register /compact command

1. Add `"/compact"` to `CANCEL_CAPABLE_COMMANDS` set.
2. Add a `/compact` case in the switch that:
   - If `!session`: reply "No active session to compact."
   - If `!existingRunner`: reply "No active runner to compact." (edge case: session bound but runner disposed — should be rare, but defend)
   - Else: call `existingRunner.compact(instructions)` where `instructions` is the text after `/compact`, if any
   - On success: reply `"Compacted from ~<tokensBefore>K tokens."`
   - On error: reply with pi's error message

Affects: **Added** requirements "Compact command triggers manual context compaction" and "Compact command is registered as a cancel-capable command".

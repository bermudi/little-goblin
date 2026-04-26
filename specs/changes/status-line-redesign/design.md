# Status Line Redesign — Design

## Architecture

The redesign keeps `MessageBuffer` as the sole `TurnCallbacks` implementer; no other components shift. Internally, the tool-state map (`Map<string, ToolState>`) is replaced by a phase state machine driven by counters and an error flag:

```
        agent_start (onStatusUpdate "thinking…")
                 │
                 ▼
        ┌───────────────┐
        │   Thinking    │  "🤔 thinking…"
        └──────┬────────┘
       first onToolStart
                 │
                 ▼
        ┌───────────────┐
        │    Working    │  "🔧 working: <names>"
        └──────┬────────┘
   all observed tools ended
                 │
                 ▼
        ┌───────────────┐
        │     Done      │  "✅ <names>"  or  "❌ <names>"
        └───────────────┘
                 │
            agent_end (frozen)
```

The transition into each phase (and only the transition) triggers a single `flushStatus(force=true)`. Within a phase, additional events (more tools starting, the same tool ending) update internal state but do **not** schedule additional flushes — except for the `Working → Done` boundary which fires exactly once when the last running tool ends.

The existing `flushStatus` machinery (statusMessageId tracking, throttle, error recovery) is preserved unchanged.

## State

Replace these fields:
```ts
private toolStates: Map<string, ToolState>;
```

With these:
```ts
private phase: "thinking" | "working" | "done" = "thinking";
private toolsObserved: string[] = [];           // insertion order, visible-only
private toolsRunning: Set<string> = new Set();  // visible-only
private hadError: boolean = false;
private statusFrozen: boolean = false;          // set on agent_end
private placeholderSent: boolean = false;
```

Filtering by `shouldShowTool(name, visibility)` happens at insertion time, so `toolsObserved` and `toolsRunning` only ever contain names that should be rendered.

## Decisions

### Eager placeholder via `onStatusUpdate`

**Chosen:** `MessageBuffer.onStatusUpdate(_msg)` becomes meaningful — when invoked while `placeholderSent === false` and visibility is not `"none"`, it triggers an immediate `flushStatus(force=true)` to land the `"🤔 thinking…"` placeholder. `AgentRunner` already calls `onStatusUpdate("thinking...")` on `agent_start`, so no `TurnCallbacks` interface change is needed.

**Why:** Adding `onAgentStart` to the public `TurnCallbacks` interface is a wider change than necessary. Reusing the existing hook is cheap and correct.

**Constraint:** The placeholder is "first event wins". If `onToolStart` or `onTextDelta` fires before any `onStatusUpdate` (defensive case for future agents that skip agent_start), the buffer falls back to sending the placeholder lazily on first state change. The eager path is the happy path; the lazy path is the safety net.

### Phase coalescing instead of per-tool state

**Chosen:** Three coarse phases with edit-on-transition only.

**Why:** The existing per-tool emoji choreography produces `2 × tool_count` edits per turn and renders fragmented info ("✅ read 🔧 bash"). The phase model produces ≤3 edits per turn and renders aggregated info ("🔧 working: bash, read") that scales gracefully with tool count.

**Alternative rejected:** Keep per-tool tracking but throttle harder. Rejected because the rendered string still grows unboundedly and the visual blink-per-edit is the dominant complaint, not the request rate.

### Tool ordering in rendered phase

**Chosen:** Insertion order (the order tools first appeared in the turn).

**Why:** Reflects the agent's actual execution narrative. Alphabetical sort would scramble the story; sorted-by-end-time mixes future state into the Working phase.

### Final status is a resting summary, not a deletion

**Chosen:** On `onAgentEnd`, force-flush the Done phase string and set `statusFrozen = true`. Do not delete the status message.

**Why:** Deletion-on-end loses the record of "what tools ran in this turn". Users can scroll back to see the Done summary. Deletion would also create flicker as the status appears and immediately disappears.

**Alternative considered:** Delete the placeholder for zero-tool turns to avoid pointless `"🤔 thinking…"` residue. **Decision:** edit the placeholder to an empty string; if Telegram rejects empty edits, fall back to leaving the `"🤔 thinking…"` message in place. Implementation MAY simplify by always leaving the placeholder, since chat history will rarely contain zero-tool turns once response streaming dominates the chat.

### `✍️ composing` is removed

**Chosen:** Drop the indicator. Liveness is conveyed by `chat_action("typing")` only.

**Why:** The two indicators were redundant. `chat_action` is Telegram's native pattern; a synthetic emoji in a status message duplicates it without adding value.

### Throttle still applies but rarely engages

**Chosen:** Keep the existing 1000ms throttle on `flushStatus`. Phase transitions use `force=true` so they always land. The throttle now mainly defends against pathological event storms (e.g., a buggy tool emitting 100 starts/ends rapidly), not against design-level churn.

**Why:** Defense-in-depth. The throttle costs nothing when transitions are rare.

## File Changes

### Modified

- **`src/tg/buffer.ts`** — Replace `toolStates: Map<string, ToolState>` with the phase fields listed under **State**. Replace `buildStatusLine()` with a phase-rendering function. Modify `onToolStart`, `onToolEnd`, `onTextDelta`, `onStatusUpdate`, `onAgentEnd`:
  - `onStatusUpdate(msg)` — if `!placeholderSent && visibility !== "none"`, set `placeholderSent = true` and `void flushStatus(true)`. Otherwise no-op.
  - `onToolStart(name, _)` — if visible, push to `toolsObserved`, add to `toolsRunning`. If `phase === "thinking"`, transition to `"working"` and `void flushStatus(true)`. If already `"working"`, no flush.
  - `onToolEnd(name, isError)` — if visible, remove from `toolsRunning`, set `hadError ||= isError`. If `toolsRunning.size === 0` and `phase === "working"`, transition to `"done"` and `void flushStatus(true)`.
  - `onTextDelta(delta)` — unchanged for response side. For status side: lazy-send placeholder if not yet sent; do **not** schedule status edits per delta (no more "composing" churn).
  - `onAgentEnd()` — set `statusFrozen = true`, transition `phase` to `"done"` if not already, `void flushStatus(true)` once, then preserve existing response force-flush and chat-action stop.
  - `flushStatus()` — early-return when `statusFrozen` is set.
  - `buildStatusLine()` — render based on `phase`, `toolsObserved`, `toolsRunning`, `hadError`. Return empty string when visibility is `"none"`.
  - Covers: **Status placeholder sent eagerly on agent_start**, **Status renders coalesced phases**, **Final status state is a resting summary**, **Status line coalesces tool activity** (modified), **Tool visibility config filters status display** (modified).

- **`src/tg/buffer.test.ts`** — Replace per-tool emoji assertions with phase-based assertions. Add tests for:
  - Eager placeholder on `onStatusUpdate("thinking...")` lands before any response message.
  - Working phase renders comma-joined visible tool names.
  - Done phase prefix flips to `"❌"` if any tool errored.
  - At most three Telegram writes per typical turn (1 send + 2 edits).
  - `statusFrozen` blocks post-agent_end edits.
  - Existing throttle / 429 / message-gone tests adapted to phase transitions.

### Not touched

- **`src/agent/mod.ts`** — already fires `onStatusUpdate("thinking...")` on `agent_start`; no interface change needed.
- **`src/bot.ts`** — `MessageBuffer` is constructed identically; integration unchanged.
- **`src/config.ts` / `src/schema.ts`** — `toolVisibility` semantics unchanged; no new levels.
- **Response streaming, rollover, file escape, chat_action refresh** — none of these paths touch tool state; they remain as-is.

### Backwards compatibility

This is a behavior change inside `MessageBuffer` only. The `TurnCallbacks` interface, `MessageBufferOptions`, and the constructor signature are unchanged. Configs from previous versions continue to load.

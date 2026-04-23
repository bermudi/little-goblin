# Message Buffer & Streaming — Design

## Architecture

```
AgentRunner emits TurnCallbacks
         │
         ▼
┌─────────────────────────────────────┐
│  MessageBuffer implements           │
│  TurnCallbacks                      │
│                                     │
│  ┌─ StatusAccumulator ─┐  ┌─ TextAccumulator ─┐
│  │ tool state machine   │  │ chars + rollover  │
│  │ 1 edit/sec throttle  │  │ 4096 threshold    │
│  └──────────┬────────────┘  └────────┬──────────┘
│             │                      │
│             ▼                      ▼
│  Status Message (edited)    Response Message(s)
│  "🧠 thinking 🔧 bash ✅"     (edited, rolled)
│             │                      │
│             └──────┬───────────────┘
│                    ▼
│           bot.api.send*/edit*
└─────────────────────────────────────┘
```

**Key separation:** Status line (tool activity) and response stream (LLM text) are separate Telegram messages. This prevents tool activity from pushing response text out of view.

## Decisions

### Separate status and response messages

**Chosen:** Two distinct messages per turn — one for status (tool emoji state), one for response text.

**Why:** If we edited a single message with both tool status and response text, rapid tool activity would constantly move the cursor/scroll position, making the response hard to read. Separate messages let the response accumulate peacefully while status updates above it.

**Constraint:** We need two message IDs to track per turn. Buffer state includes `{statusMessageId?: number, responseMessageId?: number}`.

### 4096 rollover, not truncation

**Chosen:** When response exceeds 4096 chars, send the current message and start a new one.

**Why:** Telegram message limit is 4096. Splitting preserves all content; truncation loses information. Users can read the full response across multiple messages.

**Alternative rejected:** File attachment at 4096. Too aggressive — most responses are 500-2000 chars; splitting is fine. We only file-escape at ~20KB.

### 20KB file escape threshold

**Chosen:** When response exceeds ~20000 characters, send as `reply.md` attachment with summary.

**Why:** 5 messages of 4096 is already spammy. Big outputs (code dumps, logs) belong in files. 20KB is ~5 messages; beyond that, readability suffers.

**Summary content:** First 500 chars + "... [truncated, see attached reply.md]".

### Tool visibility levels

**Chosen:** Five levels (none, minimal, standard, verbose, debug) with predefined tool lists.

**Why:** Users have different preferences. Some want to see every tool call; others just want the result. Levels provide predictable behavior without complex configuration.

**Level definitions:**
| Level | Visible tools |
|-------|--------------|
| none | (no status line) |
| minimal | bash, write, edit, spawn_subagent |
| standard | bash, write, edit, read, grep, spawn_subagent (α tools) |
| verbose | α + γ tools (revive_subagent, list_subagents) |
| debug | everything including internal events |

**Where stored:** `~/goblin/config.json` under `ui.toolVisibility`, default "standard".

### ~1 edit/sec throttle for status (approximate)

**Chosen:** Track last edit timestamp, skip edits if <1000ms since last, unless `onAgentEnd` (always flush).

**Why:** Strict 1-second timers are fragile (setTimeout drift, event loop delays). Approximate throttling is simpler and sufficient for flood prevention.

**Edge case:** If we fall behind by >5 seconds, we drop intermediate states and jump to current state. Better than spamming 5 rapid edits.

### Response text edit throttle at ~5/sec

**Chosen:** Throttle response message edits to max 5 per second, with coalescing for bursts.

**Why:** Response text arrives as many small deltas (100ms intervals). Editing 10 times/second would hit Telegram rate limits. 5/sec is smooth enough for reading while staying well under limits.

**Implementation:** Similar to status throttle but with 200ms threshold instead of 1000ms.

### chat_action refresh

**Chosen:** 4-second refresh while streaming, "typing" action.

**Why:** Telegram shows typing indicator for ~5 seconds after receiving. Refreshing every 4s keeps it alive during long turns.

**Implementation:** Set interval on first `onTextDelta`, clear on `onAgentEnd`.

## File Changes

### New files

- **`src/tg/buffer.ts`** — `MessageBuffer` class implementing `TurnCallbacks`.
  - Tracks `statusMessageId`, `responseMessageId`, accumulated text, tool states, last edit time.
  - Methods: all `TurnCallbacks`, internal `flushStatus()`, `flushResponse()`, `maybeRollover()`.
  - Handles >20KB detection and file escape.
  - Covers: all status line, streaming, rollover, visibility, throttle requirements.

- **`src/tg/buffer.test.ts`** — Unit tests:
  - Mock grammy bot, verify edit calls are throttled.
  - Verify 4096 rollover creates new message.
  - Verify >20KB triggers file attachment.
  - Verify visibility levels filter tool display.
  - Verify errors are swallowed, not thrown.

### Modified files

- **`src/tg/mod.ts`** — Export `MessageBuffer` (if not already in barrel).
- **`src/bot.ts`** — Replace stub `TurnCallbacks` with real `MessageBuffer`:
  ```typescript
  const buffer = new MessageBuffer(bot, chatId, {
    visibility: config.toolVisibility // from ~/goblin/config.json
  });
  runner.prompt(text, buffer);
  ```
  - Covers: integration of buffer into message flow.

- **`src/config.ts`** — Add `toolVisibility` to persisted config, default "standard".

### Not touched

- `src/agent/` — no changes; buffer implements interface, agent doesn't know about it.
- `src/sessions/` — no changes.
- `src/commands/` — no new commands in this scope.

## State machine

Status line emoji state machine:
```
initial → 🧠 (on turn start)
tool_start → 🔧 <tool_name>
tool_end success → ✅ <tool_name>
tool_end error → ❌ <tool_name>
agent_end → (final state, no change)
```

Multiple tools accumulate: "✅ read 🔧 bash ✍️ composing"

The "✍️ composing" appears when we have text deltas but no active tool.

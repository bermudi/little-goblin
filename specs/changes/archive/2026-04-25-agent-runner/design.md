# Agent Runner — Design

## Architecture

`AgentRunner` sits between the Telegram layer (`src/tg/`) and `pi-coding-agent`. It owns pi's `AgentSession` for one Goblin session, translates pi events into a telegram-agnostic `TurnCallbacks` interface, and writes a complete audit log to `sessions/<id>/events.jsonl`.

```
┌────────────────────────────────────────────────────────────────┐
│  src/tg/ (grammy, MessageBuffer, β tools)                      │
│                                                                 │
│   on message → runner.prompt(text, callbacks)                   │
│                callbacks.onTextDelta/onToolStart/.../onAgentEnd │
└───────────────────────┬────────────────────────────────────────┘
                        │ ToolDefinition[] (β tools, closures)
                        │ TurnCallbacks (interface)
┌───────────────────────▼────────────────────────────────────────┐
│  src/agent/ (AgentRunner)                                      │
│                                                                 │
│   lazy create AgentSession                                      │
│   subscribe to events → dispatch callbacks + append events.jsonl│
│   cwd = $GOBLIN_HOME/workdir/                                   │
│   shared services = $GOBLIN_HOME/pi-agent/                      │
└───────────────────────┬────────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────────┐
│  @mariozechner/pi-coding-agent                                  │
│   AgentSession (LLM, built-in tools, custom tools, events)      │
│   SessionManager.inMemory() for main goblin                     │
└────────────────────────────────────────────────────────────────┘
```

**Boundary invariants:**
- `src/agent/` never imports grammy or `src/tg/*`.
- `src/tg/` never imports from `@mariozechner/pi-coding-agent` directly.
- All pi event types are dropped at the runner boundary; Telegram code sees `TurnCallbacks` only.

## Decisions

### One AgentRunner per Goblin session

**Chosen:** One runner per `sessionId`, held by the Telegram layer in a `Map<sessionId, AgentRunner>`.

**Why:** Pi's `AgentSession` is stateful and expensive (LLM context, tool registry, streaming state). Recreating per turn would drop conversation history. Creating a pool or sharing across sessions would violate "one turn at a time per session" and require a queue on top of pi's already-sufficient `followUp` mechanism.

**Alternative rejected:** Single global runner with session-ID-as-parameter. Would break pi's single-threaded turn model and force a custom queue.

**Constraint introduced:** Runners accumulate in memory over the process's lifetime. For v1 (single user, bounded sessions) this is fine. v2 may need idle eviction.

### Pi's SessionManager runs in inMemory() mode

**Chosen:** `SessionManager.inMemory()` for the main goblin.

**Why:** Pi's disk-backed session manager persists conversation history as JSONL trees with branching/compaction. We don't need that for the main goblin — the audit trail lives in `events.jsonl` (our own log), and conversations reset when the process restarts (goblin is one persistent entity, not a persistent conversation).

Subagents will use pi's disk-backed sessions because revival is a v1 requirement for them (see `subagent-runtime` change). Keeping the main goblin in-memory avoids accidentally persisting Telegram user messages in two places.

**Alternative rejected:** Persisted pi session at `sessions/<id>/pi-session.jsonl`. Would duplicate state with `events.jsonl` and introduce a "what's the source of truth" question.

### Every tool call fires callbacks; filtering is downstream

**Chosen:** `AgentRunner` emits `onToolStart`/`onToolEnd` for every tool, no filtering.

**Why:** The runner has no opinion about what the user wants to see in Telegram. Tool visibility config (levels: `none`, `minimal`, `standard`, `verbose`, `debug`) is a UI concern — it lives in `MessageBuffer`. Keeping the runner uniform means `events.jsonl` is always complete (audit trail) and changing visibility doesn't affect what the runner records.

### cwd is fixed, workdir is shared

**Chosen:** `cwd = $GOBLIN_HOME/workdir/` for every runner.

**Why:** Goblin is one persistent entity. Files, memory, and skills accumulate across all Telegram sessions. Per-session workdirs would fragment goblin's workspace and break the `~/goblin/AGENTS.md` + `~/goblin/skills/` discovery model.

**Constraint introduced:** Two sessions can race on the same files. Git discipline (goblin commits before risky ops) and homelab snapshots handle this. No locking in v1.

### Shared services at $GOBLIN_HOME/pi-agent/

**Chosen:** `AuthStorage.create($GOBLIN_HOME/pi-agent/auth.json)`, likewise for `ModelRegistry` and `SettingsManager`.

**Why:** Pi defaults to `~/.pi/agent/`. We override to keep all goblin state under one tree (`$GOBLIN_HOME`). One auth/settings store shared by every session matches "goblin is one entity."

### Custom tools arrive pre-bound

**Chosen:** Caller constructs β tools with `chatId`/`messageId`/`topicId` baked into closures and passes them to `AgentRunner` as `customTools: ToolDefinition[]`.

**Why:** See `progress.md` β tool binding decision. The runner stays telegram-agnostic; the LLM can't hallucinate wrong chat targets.

### In-flight prompts use pi's followUp

**Chosen:** When `prompt()` is called during streaming, dispatch via `AgentSession.followUp(text)`. When idle, dispatch via `sendUserMessage(text)`.

**Why:** Pi's queueing is already correct — follow-up delivers after the current turn finishes all tool calls, preserving order. No custom queue.

**Alternative rejected:** `steer()` (delivers mid-turn, before next LLM call). Rejected because it interrupts the turn and is more appropriate for "change course" than "here's my next message."

## File Changes

### New files

- **`src/agent/mod.ts`** — Replaces the current stub. Exports `AgentRunner` class and `TurnCallbacks` interface.
  - Covers requirements: all in `specs/agent/spec.md`.
- **`src/agent/events.ts`** — Helper: append a JSON line to `events.jsonl` with atomic write semantics (open `O_APPEND`, single `write()` call per line).
  - Covers: "Complete event log written to sessions/<id>/events.jsonl" (atomic line writes).
- **`src/agent/paths.ts`** — Pure functions: `workdirPath(home)`, `piAgentDir(home)`, `agentsMdPath(home)`.
  - Covers: cwd, shared services, AGENTS.md location.
- **`src/agent/mod.test.ts`** — Integration test with a stub pi session (or real pi against a mock model): verifies callback dispatch order, events.jsonl append, cwd/services configuration, abort semantics.

### Modified files

- **`src/config.ts`** — `ensureGoblinHome()` must create `$GOBLIN_HOME/workdir/` and `$GOBLIN_HOME/pi-agent/` in addition to existing dirs.
  - Covers: shared services location + cwd path existence.
- **`src/sessions/paths.ts`** — Add `eventsPath(home, id)` if not already present (it is — verify). No change expected.
- **`src/bot.ts`** — On message receive, resolve `sessionId`, look up or create the `AgentRunner` for that session, build `TurnCallbacks` (stub in this change; real `MessageBuffer` implementation arrives in `message-buffer-streaming`), call `runner.prompt(text, callbacks)`. Hold runners in a `Map<string, AgentRunner>`.
  - Covers: "AgentRunner lifecycle is scoped to a Telegram session" (same instance reused), "Different sessions, concurrent activity" (separate instances).

### Not touched

- `src/tg/` — no changes in this scope; β tools are a separate change.
- `src/sessions/` — no behavior changes; the runner consumes paths but doesn't mutate the session manager.
- `src/commands/` — no new commands in this scope.

## Testing notes

The trickiest test is "every tool call fires callbacks without filtering." Approach: construct an `AgentRunner` with a custom tool that just echoes args, drive a turn that invokes it, and assert `onToolStart`/`onToolEnd` fired with the right name and args. Built-in tool behavior is covered by pi's own test suite; we verify our translation layer.

For "shared services are read across sessions": two runners, same `$GOBLIN_HOME`, write via one → read via other. Don't mock pi's `AuthStorage`; use the real one against a temp dir.

For "no grammy imports": a lint rule or a test that walks `src/agent/` imports and asserts no match for `^grammy` or `../tg/`.

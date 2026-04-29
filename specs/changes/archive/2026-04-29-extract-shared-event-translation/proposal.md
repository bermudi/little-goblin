## Motivation

`AgentRunner.handleEvent()` and `SubagentRunner.handleEvent()` each contain a `switch` on the same five `AgentSessionEvent` types (`agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`). The dispatch logic is structurally identical — both translate pi events into typed callbacks — but the two inline switches have diverged in their callback wiring, making the duplication non-obvious and creating two places to touch when pi's event types change.

Extracting a single `dispatchAgentEvent(event, callbacks)` function into `src/agent/events.ts` eliminates the duplication, gives both runners the same well-typed event-to-callback translation, and makes the existing `TurnCallbacks` interface the canonical event dispatch contract (rather than a Telegram-specific concern living in `agent/mod.ts`).

## Scope

- **Move** `TurnCallbacks` from `src/agent/mod.ts` to `src/agent/events.ts`. Update all importers (`src/tg/buffer.ts`).
- **Add** `dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void` to `src/agent/events.ts`. The function contains the switch on event types and invokes the corresponding callback for each case.
- **Replace** the inline switch in `AgentRunner.handleEvent()` with a call to `dispatchAgentEvent(event, this.callbacks)`. Event logging via `appendEvent` stays in `handleEvent`, called before dispatch.
- **Replace** the inline switch in `SubagentRunner.handleEvent()` with a local `TurnCallbacks` adapter object that maps the typed callbacks to the subagent's existing `hooks` and `instance.onStatusUpdate`, then delegates to `dispatchAgentEvent`.
- **No behavioral changes** — every callback fires at the same time, with the same arguments, for the same events. Tests pass without modification.

Capabilities affected:
- `agent` — internal refactoring of event dispatch
- `subagents` — internal refactoring of event dispatch
- `message-buffer` — import path update only (re-export from `agent/mod.ts` preserved for compat)

## Non-Goals

- Not merging `AgentRunner` and `SubagentRunner` — they remain separate classes.
- Not changing event logging (`appendEvent`) — the logging call stays in `AgentRunner.handleEvent` before dispatch.
- Not adding a new abstraction layer, port, or `EventAdapter` class — this is a single free function.
- Not changing callback semantics — `onToolStart`, `onToolEnd`, `onTextDelta`, `onStatusUpdate`, `onAgentEnd` fire identically.
- Not touching the subagent lifecycle FSM — the `if (instance.status !== "running")` guards remain exactly as-is.
- Not changing the `TurnCallbacks` method signatures — the interface is moved, not reshaped.
- Not extracting the `MessageBuffer.buildStatusLine` phase machine.

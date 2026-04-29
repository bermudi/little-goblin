# subagents

## ADDED Requirements

### Requirement: SubagentRunner dispatches events through shared dispatchAgentEvent

The `SubagentRunner.handleEvent()` method SHALL construct a local `TurnCallbacks` adapter object and delegate pi event dispatch to `dispatchAgentEvent(event, callbacks)` from `src/agent/events.ts`. The adapter SHALL map the typed `TurnCallbacks` methods to the subagent's existing callback surface:

- `onTextDelta(delta)` → `hooks.onText(delta)`
- `onToolStart(name)` → `instance.onStatusUpdate?.(``tool: ${name}``)`
- `onToolEnd(name, isError)` → `instance.onStatusUpdate?.(``tool ${isError ? "error" : "ok"}: ${name}``)`
- `onStatusUpdate(message)` → `instance.onStatusUpdate?.(message)`
- `onAgentEnd()` → `hooks.onEnd()`

The adapter SHALL be constructed fresh per-event (no retained state). The inline `switch` statement SHALL be removed from `SubagentRunner.handleEvent`.

#### Scenario: Subagent receives a text delta event

- **WHEN** a `message_update` event with `text_delta` arrives for a subagent
- **THEN** `hooks.onText(delta)` SHALL be called with the delta string
- **AND** the call SHALL be identical in timing and value to the prior inline switch

#### Scenario: Subagent receives a tool start event

- **WHEN** a `tool_execution_start` event arrives for a subagent
- **THEN** `instance.onStatusUpdate("tool: <name>")` SHALL be called

#### Scenario: Subagent completes

- **WHEN** an `agent_end` event arrives for a subagent
- **THEN** `hooks.onEnd()` SHALL be called exactly once

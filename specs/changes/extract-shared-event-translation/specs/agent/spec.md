# agent

## ADDED Requirements

### Requirement: Shared event dispatch function in agent/events.ts

`src/agent/events.ts` SHALL export `dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void` that translates a single pi `AgentSessionEvent` into typed callback invocations. The function SHALL cover all five event types that both runners consume: `agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`. All other event types SHALL be ignored (no-op).

The dispatch behavior for each event type SHALL be:

- `agent_start` → `callbacks.onStatusUpdate("thinking...")`
- `message_update` with `text_delta` → `callbacks.onTextDelta(event.assistantMessageEvent.delta)`
- `message_update` with non-text-delta (e.g. `message_start`, `message_end`) → ignored
- `tool_execution_start` → `callbacks.onToolStart(event.toolName, event.args)`
- `tool_execution_end` → `callbacks.onToolEnd(event.toolName, event.isError === true)`
- `agent_end` → `callbacks.onAgentEnd()`

The function MUST NOT perform any side effects beyond invoking callbacks — no logging, no event appending, no state mutation.

#### Scenario: Text delta event

- **WHEN** `dispatchAgentEvent` is called with a `message_update` event whose `assistantMessageEvent.type === "text_delta"`
- **THEN** `callbacks.onTextDelta` SHALL be invoked with `event.assistantMessageEvent.delta`

#### Scenario: Tool start event

- **WHEN** `dispatchAgentEvent` is called with a `tool_execution_start` event
- **THEN** `callbacks.onToolStart` SHALL be invoked with `(event.toolName, event.args)`

#### Scenario: Tool end event

- **WHEN** `dispatchAgentEvent` is called with a `tool_execution_end` event
- **THEN** `callbacks.onToolEnd` SHALL be invoked with `(event.toolName, event.isError === true)`

#### Scenario: Agent end event

- **WHEN** `dispatchAgentEvent` is called with an `agent_end` event
- **THEN** `callbacks.onAgentEnd` SHALL be invoked

#### Scenario: Unknown event type

- **WHEN** `dispatchAgentEvent` is called with an unrecognized event type (e.g., `turn_start`, `compaction_start`)
- **THEN** no callback SHALL be invoked
- **AND** no error SHALL be thrown

### Requirement: TurnCallbacks interface defined in agent/events.ts

The `TurnCallbacks` interface SHALL be defined in `src/agent/events.ts` with its existing five methods: `onTextDelta(text: string)`, `onToolStart(name: string, input: unknown)`, `onToolEnd(name: string, isError: boolean)`, `onStatusUpdate(message: string)`, `onAgentEnd()`. The interface SHALL be re-exported from `src/agent/mod.ts` for backward compatibility.

#### Scenario: Existing importers continue to compile

- **WHEN** `import { TurnCallbacks } from "../agent/mod.ts"` is used in `src/tg/buffer.ts`
- **THEN** the import SHALL resolve and the type SHALL be identical to `import { TurnCallbacks } from "../agent/events.ts"`

#### Scenario: New consumers import from events.ts

- **WHEN** a new module imports `{ TurnCallbacks }` from `src/agent/events.ts`
- **THEN** it SHALL receive the same interface as importing from `src/agent/mod.ts`

## MODIFIED Requirements

### Requirement: AgentRunner exposes a TurnCallbacks interface

The `AgentRunner.prompt()` method SHALL accept a `TurnCallbacks` object (imported from `src/agent/events.ts`) and invoke its methods as pi events arrive. `AgentRunner.handleEvent()` SHALL delegate callback dispatch to `dispatchAgentEvent(event, callbacks)` from `src/agent/events.ts`, after completing its own event logging via `appendEvent`. The callback invocation order and arguments SHALL be identical to the prior inline switch.

#### Scenario: Text streaming

- **WHEN** pi emits a `text_delta` during a turn
- **THEN** `callbacks.onTextDelta(delta)` SHALL be called synchronously with the delta string

#### Scenario: Tool execution

- **WHEN** pi emits `tool_execution_start`
- **THEN** `callbacks.onToolStart(name, args)` SHALL be called before the tool runs
- **AND** when pi emits `tool_execution_end`, `callbacks.onToolEnd(name, isError)` SHALL be called

#### Scenario: Turn completion

- **WHEN** pi emits `agent_end`
- **THEN** `callbacks.onAgentEnd()` SHALL be called exactly once

#### Scenario: Event logged before dispatch

- **WHEN** any pi event arrives
- **THEN** `appendEvent` SHALL be called on the event before `dispatchAgentEvent` is invoked

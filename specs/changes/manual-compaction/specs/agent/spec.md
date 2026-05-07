# agent

## ADDED Requirements

### Requirement: AgentRunner exposes compact()

`AgentRunner` SHALL expose a public `compact(customInstructions?: string)` method that initializes the pi `AgentSession` lazily (same pattern as `prompt()`) and delegates to `this.session.compact(customInstructions)`. The method SHALL return pi's `CompactionResult`, which includes `summary`, `firstKeptEntryId`, and `tokensBefore`.

If pi's `compact()` throws (e.g. "Nothing to compact (session too small)"), the error SHALL propagate to the caller. The caller is responsible for formatting a user-facing reply.

If `AgentSession` initialization fails (e.g. auth error), the error SHALL propagate to the caller.

#### Scenario: Compact an active session

- **WHEN** `runner.compact()` is called on a runner whose session has multiple turns of conversation history
- **THEN** pi's `AgentSession.compact()` SHALL be invoked with no custom instructions
- **AND** the returned `CompactionResult` SHALL include a non-empty `summary` string, `tokensBefore` > 0, and a non-empty `firstKeptEntryId`

#### Scenario: Compact with custom instructions

- **WHEN** `runner.compact("focus on schema decisions")` is called
- **THEN** pi's `AgentSession.compact("focus on schema decisions")` SHALL be invoked

#### Scenario: Nothing to compact

- **WHEN** `runner.compact()` is called on a session with minimal history (e.g. a single short prompt)
- **THEN** the promise SHALL reject with an error from pi

#### Scenario: Lazy initialization

- **WHEN** `runner.compact()` is called before any `prompt()` call
- **THEN** the runner SHALL call `init()` to create the pi `AgentSession` first
- **AND** then delegate to `this.session.compact()`

## MODIFIED Requirements

### Requirement: Shared event dispatch function in agent/events.ts

`src/agent/events.ts` SHALL export `dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void` that translates a single pi `AgentSessionEvent` into typed callback invocations. The function SHALL cover all event types that runners consume: `agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `compaction_start`, and `compaction_end`. All other event types SHALL be ignored (no-op).

The dispatch behavior for each event type SHALL be:

- `agent_start` → `callbacks.onStatusUpdate("thinking...")`
- `message_update` with `text_delta` → `callbacks.onTextDelta(event.assistantMessageEvent.delta)`
- `message_update` with non-text-delta (e.g. `message_start`, `message_end`) → ignored
- `tool_execution_start` → `callbacks.onToolStart(event.toolName, event.args)`
- `tool_execution_end` → `callbacks.onToolEnd(event.toolName, event.isError === true)`
- `agent_end` → `callbacks.onAgentEnd()`
- `compaction_start` → `callbacks.onStatusUpdate("🗜 compacting…")`
- `compaction_end` → `callbacks.onStatusUpdate(…)` with a summary formed from `event.result` (e.g. `"compacted from <tokensBefore> tokens"`)

The function MUST NOT perform any side effects beyond invoking callbacks — no logging, no event appending, no state mutation.

#### Scenario: Compaction start event

- **WHEN** `dispatchAgentEvent` is called with a `compaction_start` event
- **THEN** `callbacks.onStatusUpdate` SHALL be invoked with `"🗜 compacting…"`

#### Scenario: Compaction end event

- **WHEN** `dispatchAgentEvent` is called with a `compaction_end` event whose `result.tokensBefore` is `42000`
- **THEN** `callbacks.onStatusUpdate` SHALL be invoked with a message indicating compaction completed (e.g. `"compacted from ~42k tokens"`)

#### Scenario: Unknown event type

- **WHEN** `dispatchAgentEvent` is called with an unrecognized event type (e.g., `turn_start`)
- **THEN** no callback SHALL be invoked
- **AND** no error SHALL be thrown

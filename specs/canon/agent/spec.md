# agent

## Requirements

### Requirement: AgentRunner lifecycle is scoped to a Telegram session

The `AgentRunner` class SHALL be instantiated once per Goblin Telegram session (identified by `sessionId`) and reused across turns within that session. A runner MUST NOT be shared across Telegram sessions.

#### Scenario: Same session, multiple turns

- **WHEN** the bot receives two user messages in the same Telegram session
- **THEN** the same `AgentRunner` instance SHALL handle both
- **AND** pi's `AgentSession` SHALL NOT be recreated between them

#### Scenario: Different sessions, concurrent activity

- **WHEN** user messages arrive in two different Telegram sessions
- **THEN** each session SHALL have its own `AgentRunner` instance
- **AND** each runner SHALL have its own pi `AgentSession`

### Requirement: AgentRunner owns pi's AgentSession

The `AgentRunner` SHALL create pi's `AgentSession` via `createAgentSession()` lazily on the first prompt.

#### Scenario: Lazy creation

- **WHEN** `AgentRunner` is constructed
- **THEN** pi's `AgentSession` SHALL NOT be created yet

#### Scenario: First prompt triggers creation

- **WHEN** the runner's `prompt()` method is called for the first time
- **THEN** pi's `AgentSession` SHALL be created before the prompt is dispatched

### Requirement: cwd is the shared goblin workspace

Every `AgentRunner` SHALL pass `cwd = workdirPath($GOBLIN_HOME)` to `createAgentSession()`, where `workdirPath` is imported from `src/pi-host.ts`. Per-session workdirs MUST NOT be used.

#### Scenario: Runner created

- **WHEN** an `AgentRunner` is instantiated in any session
- **THEN** pi's `AgentSession` SHALL run with cwd `$GOBLIN_HOME/workdir/`

### Requirement: Shared services point at $GOBLIN_HOME/pi-agent/

The `AgentRunner` SHALL obtain pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` from the `createPiServices()` function exported by `src/pi-host.ts`. `AuthStorage` and `ModelRegistry` SHALL be configured to read from and write to `$GOBLIN_HOME/pi-agent/` so authentication and model configuration persist across restarts and are shared by every session. `SettingsManager` SHALL be an in-memory instance with empty defaults.

#### Scenario: AuthStorage location

- **WHEN** an `AgentRunner` is created
- **THEN** pi's `AuthStorage` SHALL use `$GOBLIN_HOME/pi-agent/auth.json`

#### Scenario: Two sessions share the auth file path

- **WHEN** two `AgentRunner` instances are created in two different sessions
- **THEN** each runner's `AuthStorage` SHALL point at the same `$GOBLIN_HOME/pi-agent/auth.json` path

#### Scenario: Services obtained from pi-host

- **WHEN** `AgentRunner.init()` builds pi services
- **THEN** it SHALL call `createPiServices(home)` from `src/pi-host.ts`
- **AND** it SHALL NOT construct `AuthStorage`, `ModelRegistry`, or `SettingsManager` inline

### Requirement: Pi SessionManager runs in-memory for main goblin sessions

The `AgentRunner` SHALL pass `SessionManager.inMemory()` to `createAgentSession()`. Pi's conversation history for the main goblin MUST NOT be persisted to disk by pi.

#### Scenario: No pi session files written

- **WHEN** a goblin turn completes
- **THEN** no JSONL file SHALL be created by pi in `$GOBLIN_HOME/workdir/` or anywhere pi-managed

### Requirement: Complete event log written to sessions/<id>/events.jsonl

The `AgentRunner` SHALL subscribe to pi's `AgentSession` events and append every event as a JSON object on its own line to `$GOBLIN_HOME/sessions/<sessionId>/events.jsonl`. No event type is filtered out.

#### Scenario: Text delta event

- **WHEN** pi emits `text_delta`
- **THEN** a JSON line with the delta and ISO-8601 timestamp SHALL be appended to `events.jsonl`

#### Scenario: Tool call event

- **WHEN** pi emits `tool_call`
- **THEN** a JSON line with tool name, arguments, and timestamp SHALL be appended

#### Scenario: Observability-only events included

- **WHEN** pi emits `compaction_start`, `auto_retry_start`, or `queue_update`
- **THEN** each SHALL be appended as a JSON line

#### Scenario: Append is atomic per line

- **WHEN** two events are written in rapid succession
- **THEN** each line SHALL be complete and valid JSON
- **AND** neither SHALL be interleaved with the other

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

### Requirement: Every tool call fires callbacks

The `AgentRunner` MUST NOT filter tool callbacks by name, visibility, or source. Every `tool_call` and `tool_result` from pi SHALL produce a callback invocation.

#### Scenario: Read-only tool

- **WHEN** a `read` or `grep` tool is invoked
- **THEN** `onToolStart`/`onToolEnd` SHALL fire

#### Scenario: Custom β tool

- **WHEN** a custom tool (e.g., `send_voice`) is invoked
- **THEN** `onToolStart`/`onToolEnd` SHALL fire the same as built-in tools

### Requirement: AgentRunner accepts session-bound custom tools

The `AgentRunner` constructor SHALL accept `customTools: ToolDefinition[]` and pass them through to `createAgentSession({ customTools })` unchanged. The runner MUST NOT inspect, wrap, or modify those definitions.

#### Scenario: Tools passed through

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** pi's `AgentSession` SHALL be created with those exact `ToolDefinition` references

#### Scenario: Empty custom tools

- **WHEN** `AgentRunner` is constructed with `customTools = []`
- **THEN** pi SHALL run with only its built-in `codingTools`

### Requirement: AgentRunner never imports telegram libraries

The `src/agent/` directory MUST NOT import `grammy` or any `src/tg/*` module. All telegram-specific behavior SHALL arrive via `customTools` (closures) or `TurnCallbacks` (interface).

#### Scenario: Static import check

- **WHEN** the TypeScript project is compiled
- **THEN** no file under `src/agent/` SHALL have an import path starting with `grammy` or `../tg/`

### Requirement: In-flight prompts use pi's followUp queueing

When `prompt()` is called while pi is streaming, the `AgentRunner` SHALL dispatch the new message via `AgentSession.followUp()`. The runner MUST NOT implement its own queue.

#### Scenario: Rapid user messages

- **WHEN** `prompt()` is called while `AgentSession.isStreaming === true`
- **THEN** the runner SHALL call `session.followUp(text)` instead of starting a new turn

#### Scenario: Message after idle

- **WHEN** `prompt()` is called while `AgentSession.isStreaming === false`
- **THEN** the runner SHALL call `session.sendUserMessage(text)` or equivalent, starting a new turn

### Requirement: AgentRunner provides abort

The `AgentRunner` SHALL expose an `abort()` method that calls pi's `AgentSession.abort()` and resolves when pi reports idle.

#### Scenario: Abort during stream

- **WHEN** `abort()` is called while the agent is streaming
- **THEN** pi's in-flight turn SHALL be cancelled
- **AND** the promise returned by `abort()` SHALL resolve after pi becomes idle

#### Scenario: Abort when idle

- **WHEN** `abort()` is called while pi is already idle
- **THEN** the promise SHALL resolve without error

### Requirement: AgentRunner injects memory snapshot as per-turn aside

The `AgentRunner` SHALL build a per-turn snapshot from the active memory scope (resolved from the runner's `(chatId, topicId)` or named-agent identity), the global `user.md`, and the cross-scope index, and inject it into the next turn via `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })` before each `prompt()` call. The snapshot MUST be loaded fresh for every turn so that writes performed in earlier turns become visible on subsequent turns. The snapshot MUST NOT be added to pi's `_baseSystemPrompt`; whatever value `_baseSystemPrompt` holds at AgentSession creation MUST remain unchanged across turns by this change.

#### Scenario: First turn in a topic loads scoped snapshot

- **WHEN** `prompt()` is called for the first time on an `AgentRunner` bound to topic `42` in chat `-100123`
- **THEN** the runner SHALL read `topics/-100123/42/memory.md`, `user.md`, and the cross-scope index from disk
- **AND** dispatch the formatted snapshot via `sendCustomMessage(..., { deliverAs: "nextTurn" })` before invoking the underlying prompt

#### Scenario: First turn in a DM loads general snapshot

- **WHEN** `prompt()` is called for the first time on an `AgentRunner` bound to a DM chat
- **THEN** the runner SHALL read `general/memory.md`, `user.md`, and the cross-scope index from disk
- **AND** the snapshot's `## scope` section SHALL identify the active scope as `General`

#### Scenario: Subsequent turn after a memory write in the active scope

- **WHEN** the agent calls `memory_write` during turn N from a topic-bound session
- **AND** the user sends a new message that triggers turn N+1 in the same topic
- **THEN** the snapshot loaded for turn N+1 SHALL include the entry written during turn N

#### Scenario: Cross-topic write does not affect this scope's snapshot

- **WHEN** topic `7`'s `memory.md` changes between turn N and turn N+1 of a session in topic `42`
- **THEN** the snapshot for turn N+1 in topic `42` SHALL include topic `7` in the `## other scopes` index with its updated description (if any)
- **AND** topic `7`'s entries SHALL NOT appear in the active `## memory.md` section

#### Scenario: System prompt unchanged across turns

- **WHEN** any memory file changes on disk between turns
- **THEN** `agent.state.systemPrompt` between turns SHALL remain equal to the value `_baseSystemPrompt` held at AgentSession creation

#### Scenario: All scopes empty

- **WHEN** `user.md`, the active scope's `memory.md`, and every other scope are empty or absent
- **THEN** the runner MAY skip the `sendCustomMessage` call
- **AND** the prompt SHALL proceed without an aside

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include three tool definitions in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller (the requirement name is preserved from the prior `memory`-singular tool for canon continuity; the tool surface is now three distinct definitions):

1. `memory_read` — read the active scope, user.md, or any cross-scope memory.
2. `memory_read_index` — list available topic and named-agent persona scopes with descriptions.
3. `memory_write` — mutate the active scope only.

The `memory_write` tool's `target` parameter SHALL be wired to resolve to a scope based on the runner's `(chatId, topicId)` (or named-agent identity for `target: "agent"`). The agent MUST NOT be given the ability to supply an arbitrary scope on writes.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `memory_read`, `memory_read_index`, and `memory_write`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `topics/-100123/42/memory.md`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, plus the three memory tools

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

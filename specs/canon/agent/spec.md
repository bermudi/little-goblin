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

Every `AgentRunner` SHALL pass `cwd = $GOBLIN_HOME/workdir/` to `createAgentSession()`. Per-session workdirs MUST NOT be used.

#### Scenario: Runner created

- **WHEN** an `AgentRunner` is instantiated in any session
- **THEN** pi's `AgentSession` SHALL run with cwd `$GOBLIN_HOME/workdir/`

### Requirement: Shared services point at $GOBLIN_HOME/pi-agent/

The `AgentRunner` SHALL configure pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` to read from and write to `$GOBLIN_HOME/pi-agent/` so authentication and settings persist across restarts and are shared by every session.

#### Scenario: AuthStorage location

- **WHEN** an `AgentRunner` is created
- **THEN** pi's `AuthStorage` SHALL use `$GOBLIN_HOME/pi-agent/auth.json`

#### Scenario: SettingsManager location

- **WHEN** an `AgentRunner` is created
- **THEN** pi's `SettingsManager` SHALL use `$GOBLIN_HOME/pi-agent/settings.json`

#### Scenario: Two sessions, same auth

- **WHEN** auth is written by session A
- **AND** session B's runner reads auth
- **THEN** session B SHALL see the credentials session A wrote

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

The `AgentRunner.prompt()` method SHALL accept a `TurnCallbacks` object and invoke its methods as pi events arrive: `onTextDelta(delta)`, `onToolStart(name, args)`, `onToolEnd(name, isError)`, `onStatusUpdate(status)`, `onAgentEnd()`.

#### Scenario: Text streaming

- **WHEN** pi emits a `text_delta` during a turn
- **THEN** `callbacks.onTextDelta(delta)` SHALL be called synchronously with the delta string

#### Scenario: Tool execution

- **WHEN** pi emits `tool_call`
- **THEN** `callbacks.onToolStart(name, args)` SHALL be called before the tool runs
- **AND** when pi emits `tool_result`, `callbacks.onToolEnd(name, isError)` SHALL be called

#### Scenario: Turn completion

- **WHEN** pi emits `agent_end`
- **THEN** `callbacks.onAgentEnd()` SHALL be called exactly once

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

### Requirement: AgentRunner loads goblin's AGENTS.md into the system prompt

The `AgentRunner` SHALL read `$GOBLIN_HOME/AGENTS.md` at creation and include its contents in pi's system prompt. If the file is missing, the runner SHALL log a warning and proceed with the default system prompt.

#### Scenario: AGENTS.md present

- **WHEN** `$GOBLIN_HOME/AGENTS.md` exists
- **THEN** the file contents SHALL be included in pi's system prompt

#### Scenario: AGENTS.md missing

- **WHEN** `$GOBLIN_HOME/AGENTS.md` does not exist
- **THEN** a warning SHALL be logged via `log.warn`
- **AND** the runner SHALL proceed without throwing

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

The `AgentRunner` SHALL load the current contents of `$GOBLIN_HOME/memory/memory.md` and `$GOBLIN_HOME/memory/user.md` from disk before each `prompt()` call and inject them into the next turn via `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })`. The snapshot MUST be loaded fresh for every turn so that writes performed in earlier turns become visible on subsequent turns. The snapshot MUST NOT be added to pi's `_baseSystemPrompt`; whatever value `_baseSystemPrompt` holds at AgentSession creation MUST remain unchanged across turns by this change.

#### Scenario: First turn

- **WHEN** `prompt()` is called for the first time on an `AgentRunner`
- **THEN** the runner SHALL read both memory files from disk
- **AND** dispatch the formatted snapshot via `sendCustomMessage(..., { deliverAs: "nextTurn" })` before invoking the underlying prompt

#### Scenario: Subsequent turn after a memory write

- **WHEN** the agent calls `memory.add` during turn N
- **AND** the user sends a new message that triggers turn N+1
- **THEN** the snapshot loaded for turn N+1 SHALL include the entry written during turn N

#### Scenario: System prompt unchanged across turns

- **WHEN** memory files change on disk between turns
- **THEN** `agent.state.systemPrompt` between turns SHALL remain equal to the value `_baseSystemPrompt` held at AgentSession creation

#### Scenario: Empty memory store

- **WHEN** both memory files are absent or empty
- **THEN** the runner MAY skip the `sendCustomMessage` call
- **AND** the prompt SHALL proceed without an aside

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include a tool definition named `memory` in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller.

#### Scenario: Runner constructed

- **WHEN** `AgentRunner` is constructed for a Telegram session
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include a tool definition named `memory`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, and the `memory` tool

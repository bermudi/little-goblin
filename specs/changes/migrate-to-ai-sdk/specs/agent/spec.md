# agent

## MODIFIED Requirements

### Requirement: AgentRunner lifecycle is scoped to a Telegram session

The `AgentRunner` class SHALL be instantiated once per Goblin Telegram session (identified by `sessionId`) and reused across turns within that session. A runner MUST NOT be shared across Telegram sessions. The runner owns a `ModelMessage[]` conversation history array that persists across turns within the session.

#### Scenario: Same session, multiple turns

- **WHEN** the bot receives two user messages in the same Telegram session
- **THEN** the same `AgentRunner` instance SHALL handle both
- **AND** the internal `ModelMessage[]` array SHALL accumulate across both turns

#### Scenario: Different sessions, concurrent activity

- **WHEN** user messages arrive in two different Telegram sessions
- **THEN** each session SHALL have its own `AgentRunner` instance
- **AND** each runner SHALL have its own `ModelMessage[]` history

### Requirement: cwd is the shared goblin workspace

Every `AgentRunner` SHALL use `workdirPath($GOBLIN_HOME)` as the working directory context for tool execution. The `workdirPath` helper SHALL be imported from `src/paths.ts`.

#### Scenario: Runner created

- **WHEN** an `AgentRunner` is instantiated in any session
- **THEN** tool execution SHALL use `$GOBLIN_HOME/workdir/` as cwd

### Requirement: AgentRunner exposes a TurnCallbacks interface

The `AgentRunner.prompt()` method SHALL accept a `TurnCallbacks` object (imported from `src/agent/events.ts`) and invoke its methods as AI SDK stream events arrive. `AgentRunner` SHALL iterate `streamText()`'s `fullStream` and translate each event into `TurnCallbacks` invocations via `dispatchStreamEvent(event, callbacks)` from `src/agent/events.ts`.

#### Scenario: Text streaming

- **WHEN** AI SDK emits a `text-delta` stream part during a turn
- **THEN** `callbacks.onTextDelta(text)` SHALL be called synchronously with the delta string

#### Scenario: Tool execution

- **WHEN** AI SDK emits a `tool-call` stream part
- **THEN** `callbacks.onToolStart(toolName, input)` SHALL be called
- **AND** when the tool completes, `callbacks.onToolEnd(toolName, isError)` SHALL be called

#### Scenario: Turn completion

- **WHEN** AI SDK's `streamText()` resolves (finish event)
- **THEN** `callbacks.onAgentEnd()` SHALL be called exactly once

#### Scenario: API error during stream

- **WHEN** `streamText()` encounters a network failure, rate limit, or auth error
- **THEN** `callbacks.onTextDelta()` SHALL be called with an error message prefixed with "❌ error: "
- **AND** `callbacks.onAgentEnd()` SHALL be called

### Requirement: Every tool call fires callbacks

The `AgentRunner` MUST NOT filter tool callbacks by name, visibility, or source. Every tool invocation and result from AI SDK SHALL produce a callback invocation.

#### Scenario: Read-only tool

- **WHEN** a `read` or `grep` tool is invoked
- **THEN** `onToolStart`/`onToolEnd` SHALL fire

#### Scenario: Custom β tool

- **WHEN** a custom tool (e.g., `send_voice`) is invoked
- **THEN** `onToolStart`/`onToolEnd` SHALL fire the same as built-in tools

### Requirement: AgentRunner accepts session-bound custom tools

The `AgentRunner` constructor SHALL accept `customTools: Tool[]` (AI SDK tool definitions) and include them in the tool set passed to `streamText()`. The runner MUST NOT inspect, wrap, or modify those definitions.

#### Scenario: Tools passed through

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the AI SDK `streamText()` call SHALL include those exact tools

#### Scenario: Empty custom tools

- **WHEN** `AgentRunner` is constructed with `customTools = []`
- **THEN** only the standard tool set (bash, read, write, edit, memory) SHALL be available

### Requirement: AgentRunner never imports telegram libraries

The `src/agent/` directory MUST NOT import `grammy` or any `src/tg/*` module. All telegram-specific behavior SHALL arrive via `customTools` (closures) or `TurnCallbacks` (interface).

#### Scenario: Static import check

- **WHEN** the TypeScript project is compiled
- **THEN** no file under `src/agent/` SHALL have an import path starting with `grammy` or `../tg/`

### Requirement: AgentRunner provides abort

The `AgentRunner` SHALL expose an `abort()` method that aborts the current `streamText()` or `generateText()` call via an `AbortController`. The runner SHALL own the `AbortController` and pass its `signal` to each call.

#### Scenario: Abort during stream

- **WHEN** `abort()` is called while the agent is streaming
- **THEN** the in-flight `streamText()` SHALL be cancelled via `AbortSignal`
- **AND** the promise returned by `abort()` SHALL resolve after the stream ends

#### Scenario: Abort when idle

- **WHEN** `abort()` is called while no turn is in progress
- **THEN** the promise SHALL resolve without error

#### Scenario: Abort during compact

- **WHEN** `abort()` is called while `compact()` is in progress
- **THEN** the in-flight `generateText()` SHALL be cancelled
- **AND** the `ModelMessage[]` SHALL remain unchanged

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include three AI SDK tool definitions in the tools passed to `streamText()`, in addition to any tools provided by the caller:

1. `memory_read` — read the active scope, user.md, or any cross-scope memory.
2. `memory_read_index` — list available topic and named-agent persona scopes with descriptions.
3. `memory_write` — mutate the active scope only.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the tool set SHALL include `memory_read`, `memory_read_index`, and `memory_write`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `topics/-100123/42/memory.md`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the tool set SHALL include `t1`, `t2`, plus the three memory tools

### Requirement: TurnCallbacks interface defined in agent/events.ts

The `TurnCallbacks` interface SHALL be defined in `src/agent/events.ts` with five methods: `onTextDelta(text: string)`, `onToolStart(name: string, input: unknown)`, `onToolEnd(name: string, isError: boolean)`, `onStatusUpdate(message: string)`, `onAgentEnd()`. The interface SHALL be re-exported from `src/agent/mod.ts` for backward compatibility.

#### Scenario: Existing importers continue to compile

- **WHEN** `import { TurnCallbacks } from "../agent/mod.ts"` is used
- **THEN** the import SHALL resolve and the type SHALL be identical to `import { TurnCallbacks } from "../agent/events.ts"`

### Requirement: AgentRunner exposes compact()

`AgentRunner` SHALL expose a public `compact(customInstructions?: string)` method that summarizes the conversation history to reclaim context window space. The method SHALL construct a summarization prompt (or use custom instructions), call AI SDK's `generateText()` to produce a summary, and replace the `ModelMessage[]` history with a system message containing the summary.

The method SHALL return `{ summary: string, tokensBefore: number }` where `tokensBefore` is the estimated token count of the conversation history before compaction and `summary` is the text produced by `generateText()`.

If the conversation history is empty or too short to compact, the method SHALL throw an error. If the agent is currently streaming, the method SHALL throw an error — compact MUST NOT run concurrently with a turn.

#### Scenario: Compact an active session

- **WHEN** `runner.compact()` is called on a runner with multiple turns of conversation history
- **THEN** a summarization call SHALL be made via AI SDK
- **AND** the `ModelMessage[]` SHALL be replaced with a compacted version containing the summary
- **AND** the return value SHALL include `summary` and `tokensBefore`

#### Scenario: Compact with custom instructions

- **WHEN** `runner.compact("focus on schema decisions")` is called
- **THEN** the summarization prompt SHALL incorporate the custom instructions

#### Scenario: Nothing to compact

- **WHEN** `runner.compact()` is called on a session with minimal history
- **THEN** the promise SHALL reject with an error

#### Scenario: Compact while streaming

- **WHEN** `runner.compact()` is called while a `streamText()` call is in progress
- **THEN** the promise SHALL reject with an error

## REMOVED Requirements

### Requirement: Shared services point at $GOBLIN_HOME/goblin/

### Requirement: Pi SessionManager runs in-memory for main goblin sessions

### Requirement: Complete event log written to sessions/<id>/events.jsonl

## RENAMED Requirements

### Requirement: AgentRunner owns pi's AgentSession → AgentRunner owns the LLM session

### Requirement: In-flight prompts use pi's followUp queueing → In-flight prompts queue in runner

### Requirement: AgentRunner injects memory snapshot as per-turn aside → AgentRunner injects memory snapshot as per-turn system message

### Requirement: Shared event dispatch function in agent/events.ts → Shared stream event dispatch function in agent/events.ts

### Requirement: Main agent skill discovery is configurable → Main agent skill discovery loads from filesystem

## ADDED Requirements

### Requirement: AgentRunner exposes context metadata

The `AgentRunner` SHALL expose read-only accessors for: `isStreaming` (boolean), `modelName` (string), `skillsLoaded` (number or null), and `contextTokens` (number or null).

#### Scenario: Streaming state

- **WHEN** a `streamText()` call is in progress
- **THEN** `isStreaming` SHALL return `true`

#### Scenario: Model name

- **WHEN** the runner is constructed with a model override
- **THEN** `modelName` SHALL return the override; otherwise the config default

#### Scenario: Context tokens after a turn

- **WHEN** a `streamText()` call completes with usage `{ promptTokens: 5000, completionTokens: 1200 }`
- **THEN** `contextTokens` SHALL return `5000`

#### Scenario: Context tokens before first turn

- **WHEN** no `streamText()` call has completed yet
- **THEN** `contextTokens` SHALL return `null`

### Requirement: Conversation history persisted to messages.jsonl

The `AgentRunner` SHALL persist the `ModelMessage[]` conversation history to `$GOBLIN_HOME/sessions/<sessionId>/messages.jsonl` after each turn completes. Each line SHALL be a single JSON-serialized `ModelMessage`. The file SHALL be appended to (not rewritten) on each turn. On process restart, the `ModelMessage[]` array SHALL be rebuilt by reading all lines from `messages.jsonl`.

#### Scenario: Turn completes

- **WHEN** a `streamText()` call finishes and `result.response.messages` are appended to the in-memory array
- **THEN** those same messages SHALL be appended as JSONL lines to `messages.jsonl`

#### Scenario: Process restart

- **WHEN** goblin restarts and an `AgentRunner` is created for a session with existing `messages.jsonl`
- **THEN** the `ModelMessage[]` array SHALL be rebuilt from the file contents
- **AND** the agent SHALL have full conversation context

#### Scenario: New session

- **WHEN** an `AgentRunner` is created for a session with no `messages.jsonl`
- **THEN** the `ModelMessage[]` array SHALL be empty

#### Scenario: Corrupted line

- **WHEN** `messages.jsonl` contains a malformed JSON line
- **THEN** the runner SHALL log a warning with the line number and skip that line
- **AND** the remaining lines SHALL still be loaded

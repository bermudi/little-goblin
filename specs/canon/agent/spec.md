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

The `AgentRunner` SHALL create pi's `AgentSession` via `createAgentSession()` lazily on the first prompt. In that lazy session-initialization path, before calling `createAgentSession()`, it SHALL construct the Goblin system prompt and provide it through the resource loader used for that session.

#### Scenario: Lazy creation

- **WHEN** `AgentRunner` is constructed
- **THEN** pi's `AgentSession` SHALL NOT be created yet
- **AND** no prompt files SHALL be read for that runner yet

#### Scenario: First prompt triggers creation

- **WHEN** the runner's `prompt()` method is called for the first time
- **THEN** pi's `AgentSession` SHALL be created before the prompt is dispatched
- **AND** the session SHALL receive the constructed Goblin system prompt

### Requirement: cwd is the shared goblin workspace

Every `AgentRunner` SHALL pass `cwd = workdirPath($GOBLIN_HOME)` to `createAgentSession()`, where `workdirPath` is imported from `src/workspace/paths.ts`. Per-session workdirs MUST NOT be used.

#### Scenario: Runner created

- **WHEN** an `AgentRunner` is instantiated in any session
- **THEN** pi's `AgentSession` SHALL run with cwd `$GOBLIN_HOME/scratch/workdir/`

### Requirement: Shared services point at $GOBLIN_HOME/state/pi/

The `AgentRunner` SHALL obtain pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` from the `createPiServices()` function exported by `src/pi-host.ts`. `AuthStorage` and `ModelRegistry` SHALL be configured to read from and write to `$GOBLIN_HOME/state/pi/` so authentication and model configuration persist across restarts and are shared by every session. `SettingsManager` SHALL be an in-memory instance with empty defaults.

#### Scenario: AuthStorage location

- **WHEN** an `AgentRunner` is created
- **THEN** pi's `AuthStorage` SHALL use `$GOBLIN_HOME/state/pi/auth.json`

#### Scenario: Two sessions share the auth file path

- **WHEN** two `AgentRunner` instances are created in two different sessions
- **THEN** each runner's `AuthStorage` SHALL point at the same `$GOBLIN_HOME/state/pi/auth.json` path

#### Scenario: Services obtained from pi-host

- **WHEN** `AgentRunner.init()` builds pi services
- **THEN** it SHALL call `createPiServices(home)` from `src/pi-host.ts`
- **AND** it SHALL NOT construct `AuthStorage`, `ModelRegistry`, or `SettingsManager` inline

### Requirement: Pi SessionManager runs in-memory for main goblin sessions

The `AgentRunner` SHALL pass `SessionManager.inMemory()` to `createAgentSession()`. Pi's conversation history for the main goblin MUST NOT be persisted to disk by pi.

#### Scenario: No pi session files written

- **WHEN** a goblin turn completes
- **THEN** no JSONL file SHALL be created by pi in `$GOBLIN_HOME/scratch/workdir/` or anywhere pi-managed

### Requirement: Complete event log written to sessions/<id>/events.jsonl

The `AgentRunner` SHALL subscribe to pi's `AgentSession` events and append every event as a JSON object on its own line to `$GOBLIN_HOME/state/sessions/<sessionId>/events.jsonl`. No event type is filtered out.

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

The `AgentRunner` SHALL expose two distinct dispatch paths for incoming user content:

- `prompt(content, callbacks)` — starts a new turn. Called when the runner is idle (`isStreaming === false`). It SHALL reset `this.callbacks` and `this.accumulatedText`, inject the per-turn memory snapshot via `sendCustomMessage(..., { deliverAs: "nextTurn" })`, then call `session.sendUserMessage(content)`. If called while `isStreaming === true`, it SHALL throw an error indicating `prompt()` cannot be used mid-stream and `followUp()` must be used instead — this makes the steer-vs-new-turn contract explicit and catches bot-layer bugs that would clobber the in-flight turn's state.
- `followUp(content)` — steers the running turn. Called when the runner is streaming (`isStreaming === true`). It SHALL call `session.followUp(content)` directly and MUST NOT reset `this.callbacks` or `this.accumulatedText`. The in-flight turn's `MessageBuffer` continues to render; the new user text is injected into the model's context mid-turn. No memory snapshot is injected on a steer — the snapshot is per-turn, and the running turn already received its snapshot at `prompt()` time.

The runner MUST NOT implement its own queue. The decision of steer-vs-queue is the bot layer's responsibility (see the orchestration capability); the runner only exposes the two primitives.

`followUp` SHALL accept the same `string | (TextContent | ImageContent)[]` content shape as `prompt` and unpack multimodal content into `session.followUp(text, images?)` the same way `prompt` does. `followUp` SHALL throw `ModelNotCapableError` under the same conditions as `prompt` (image content with a non-image model) using the same `normalizeContentForModel` path.

#### Scenario: Steer while streaming

- **WHEN** `followUp("actually use the other file")` is called while `AgentSession.isStreaming === true`
- **THEN** the runner SHALL call `session.followUp("actually use the other file")` without resetting `this.callbacks` or `this.accumulatedText`
- **AND** no memory snapshot SHALL be injected
- **AND** the in-flight turn's `MessageBuffer` SHALL continue to render the same turn

#### Scenario: New turn after idle

- **WHEN** `prompt(content, callbacks)` is called while `AgentSession.isStreaming === false`
- **THEN** the runner SHALL reset `this.callbacks` and `this.accumulatedText`, inject the memory snapshot, and call `session.sendUserMessage(content)`, starting a new turn

#### Scenario: Steer with multimodal content

- **WHEN** `followUp([{ type: "text", text: "and this image" }, { type: "image", data, mimeType }])` is called while streaming on an image-capable model
- **THEN** the runner SHALL call `session.followUp("and this image", [image])` without resetting turn state

#### Scenario: Steer rejected for incapable model

- **WHEN** `followUp` is called with image content while the resolved model does not accept image input
- **THEN** the runner SHALL throw `ModelNotCapableError` without calling `session.followUp`

#### Scenario: Steer when session not yet initialized

- **WHEN** `followUp` is called before any `prompt()` has initialized the pi `AgentSession`
- **THEN** the runner SHALL throw an error indicating the session is not initialized (e.g. "Cannot steer: session not initialized. Call prompt() first.")
- **AND** `session.followUp` SHALL NOT be called

#### Scenario: Steer rejected when not streaming

- **WHEN** `followUp(content)` is called after `init()` while `AgentSession.isStreaming === false`
- **THEN** the runner SHALL throw an error indicating the session is not streaming (e.g. "Cannot steer: session is not streaming.")
- **AND** `session.followUp` SHALL NOT be called

#### Scenario: prompt rejected while streaming

- **WHEN** `prompt(content, callbacks)` is called while `AgentSession.isStreaming === true`
- **THEN** the runner SHALL throw an error before resetting any state or calling `sendUserMessage`
- **AND** the error message SHALL indicate that `followUp()` must be used to steer a running turn
- **AND** `this.callbacks` and `this.accumulatedText` SHALL remain unchanged (the in-flight turn's state is not clobbered)

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

The `AgentRunner` SHALL build a bounded frozen memory summary at session creation and append it to `_baseSystemPrompt`. The frozen summary SHALL include the active scope description, a bounded `user.md` summary, a bounded active scope `memory.md` summary, and a cross-scope index, bounded to 1200 characters total. The frozen summary SHALL NOT be refreshed mid-session.

The `AgentRunner` SHALL NOT inject the full `[goblin memory snapshot]` per-turn aside. Instead, before each `prompt()` call it SHALL compute a `## relevant memory` section via hybrid search on the current prompt text and inject it via `sendCustomMessage(..., { deliverAs: "nextTurn" })`. The `## relevant memory` section SHALL be bounded to 3 results by default and clamped to a maximum of 5.

#### Scenario: Session creation injects frozen summary into system prompt

- **WHEN** `AgentRunner` creates a new `AgentSession`
- **THEN** `_baseSystemPrompt` SHALL include the frozen memory summary
- **AND** the frozen summary SHALL remain unchanged for the lifetime of the session

#### Scenario: Per-turn prompt injects relevant memory, not full snapshot

- **WHEN** a new user turn is dispatched via `prompt()`
- **THEN** `sendCustomMessage` SHALL be called with a `## relevant memory` section computed from the prompt text
- **AND** the message SHALL be delivered as `nextTurn`
- **AND** the full `[goblin memory snapshot]` SHALL NOT be injected

#### Scenario: Mid-turn steer does not advance cursor independently

- **WHEN** `followUp()` steers a running turn
- **THEN** the cursor SHALL not advance until the combined turn reaches `agent_end`
- **AND** the completed combined turn SHALL advance the cursor once

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include two memory tool definitions in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller:

1. `memory_search` — hybrid search over memory entries and transcript chunks. Subsumes the former `memory_read` (query omitted + scope provided → return entries) and `memory_read_index` (query omitted + scope omitted → return index).
2. `memory_write` — mutate the active scope only.

The `memory_read` and `memory_read_index` tools SHALL be removed. The `memory_write` tool's `target` parameter SHALL be wired to resolve to a `(scope, entry_kind)` pair based on the runner's `(chatId, topicId)` or named-agent identity. The agent MUST NOT be given the ability to supply an arbitrary scope on writes. The `memory_search` tool SHALL use the same active scope and chat boundary as the former `memory_read_index` unless `all_chats` is explicitly requested. Persona scope eligibility for `memory_search` SHALL match the former `memory_read_index` `agents` gating: the main goblin agent searches all persona scopes; a named subagent searches only its own persona scope; anonymous subagents search none.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `memory_search` and `memory_write`
- **AND** SHALL NOT include `memory_read` or `memory_read_index`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `scope = "topics/-100123/42"`, `entry_kind = "memory"`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, plus `memory_search` and `memory_write`

### Requirement: Shared event dispatch function in agent/events.ts

`src/agent/events.ts` SHALL export `dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void` that translates a single pi `AgentSessionEvent` into typed callback invocations. The function SHALL cover the following event types: `agent_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `compaction_start`, and `compaction_end`. All other event types SHALL be ignored (no-op).

The dispatch behavior for each event type SHALL be:

- `agent_start` → `callbacks.onStatusUpdate("thinking...")`
- `message_start` with `event.message.role === "assistant"` → `callbacks.onMessageStart(event.message)`
- `message_start` with any other role → ignored
- `message_update` with `assistantMessageEvent.type === "text_delta"` → `callbacks.onTextDelta(event.assistantMessageEvent.delta)`
- `message_update` with `assistantMessageEvent.type === "thinking_start"` or `thinking_delta` → `callbacks.onStatusUpdate("thinking...")`
- `message_update` with any other assistant message event type → ignored
- `message_end` with `event.message.role === "assistant"` → `callbacks.onMessageEnd(event.message)`
- `message_end` with `event.message.role === "assistant"` and `stopReason === "error"` or `"aborted"` and a non-empty `errorMessage` → `callbacks.onTextDelta("\n\n❌ <label>: <errorMessage>")` after `onMessageEnd`
- `message_end` with any other role → ignored
- `tool_execution_start` → `callbacks.onToolStart(event.toolName, event.args)`
- `tool_execution_end` → `callbacks.onToolEnd(event.toolName, event.isError === true)`
- `agent_end` → `callbacks.onAgentEnd()`
- `compaction_start` → `callbacks.onStatusUpdate("🗜 compacting…")`
- `compaction_end` → `callbacks.onStatusUpdate(...)` with a summary formed from `event.result`

The function MUST NOT perform any side effects beyond invoking callbacks — no logging, no event appending, no state mutation.

#### Scenario: Assistant message start emits onMessageStart

- **WHEN** `dispatchAgentEvent` is called with a `message_start` event whose `message.role` is `"assistant"`
- **THEN** `callbacks.onMessageStart` SHALL be invoked with the message

#### Scenario: User message start does not emit onMessageStart

- **WHEN** `dispatchAgentEvent` is called with a `message_start` event whose `message.role` is `"user"`
- **THEN** `callbacks.onMessageStart` SHALL NOT be invoked

#### Scenario: Assistant message end emits onMessageEnd

- **WHEN** `dispatchAgentEvent` is called with a `message_end` event whose `message.role` is `"assistant"`
- **THEN** `callbacks.onMessageEnd` SHALL be invoked with the message

#### Scenario: Tool result message end does not emit onMessageEnd

- **WHEN** `dispatchAgentEvent` is called with a `message_end` event whose `message.role` is `"toolResult"`
- **THEN** `callbacks.onMessageEnd` SHALL NOT be invoked

### Requirement: TurnCallbacks interface defined in agent/events.ts

The `TurnCallbacks` interface SHALL be defined in `src/agent/events.ts` with the following seven methods:

- `onTextDelta(text: string)`
- `onToolStart(name: string, input: unknown)`
- `onToolEnd(name: string, isError: boolean)`
- `onStatusUpdate(message: string)`
- `onMessageStart(message: AgentMessage | undefined)`
- `onMessageEnd(message: AgentMessage | undefined)`
- `onAgentEnd()`

The interface SHALL be re-exported from `src/agent/mod.ts` for backward compatibility.

`onMessageStart` and `onMessageEnd` are boundary signals for assistant messages. Implementers that do not need per-message boundaries (e.g., `GuestReplySink`) MAY implement them as no-ops.

#### Scenario: Existing consumers continue to compile

- **WHEN** `import { TurnCallbacks } from "../agent/mod.ts"` is used
- **THEN** the type SHALL include all seven methods
- **AND** the type SHALL be identical to `import { TurnCallbacks } from "../agent/events.ts"`

#### Scenario: Guest sink accepts boundaries as no-ops

- **WHEN** `GuestReplySink` implements `TurnCallbacks`
- **THEN** `onMessageStart` and `onMessageEnd` SHALL be present
- **AND** they SHALL not modify the accumulated `.text`

### Requirement: Main agent skill discovery is configurable

The `AgentRunner` SHALL construct its `DefaultResourceLoader` based on the `skillSources` config field:

- `"goblin-only"` — `noSkills: true`, `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`. Only goblin's own skills directory is available.
- `"user"` — `noSkills: false`, `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`. Pi's default auto-discovery runs (which includes `~/.agents/skills/` and cwd ancestor `.agents/skills/` dirs), plus goblin's skills.

In all modes, `agentDir` SHALL be `$GOBLIN_HOME/state/pi/` so pi's global resource lookups stay isolated from `~/.pi/agent/`.

#### Scenario: goblin-only mode (default)

- **WHEN** `skillSources` is `"goblin-only"` or absent
- **THEN** the `DefaultResourceLoader` SHALL be constructed with `noSkills: true` and `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`
- **AND** skills from `~/.agents/skills/` SHALL NOT be available to the agent

#### Scenario: user mode

- **WHEN** `skillSources` is `"user"`
- **THEN** the `DefaultResourceLoader` SHALL be constructed with `noSkills: false` and `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`
- **AND** skills from `~/.agents/skills/` and cwd ancestor `.agents/skills/` directories SHALL be available to the agent

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

### Requirement: Main AgentRunner constructs a Goblin system prompt

The main `AgentRunner` SHALL construct an explicit system prompt in its lazy session-initialization path before creating pi's `AgentSession`. The prompt SHALL combine deployment-owned prompt files, a small product shell, and optional project guidance. The prompt MUST be passed through the `DefaultResourceLoader` used by the main runner.

#### Scenario: Main runner receives explicit prompt

- **WHEN** the main `AgentRunner` initializes its pi `AgentSession` for the first prompt
- **THEN** the `DefaultResourceLoader` SHALL receive a `systemPrompt` string
- **AND** pi's default system prompt SHALL NOT be the source of the main Goblin identity

#### Scenario: Missing SOUL fails

- **WHEN** `$GOBLIN_HOME/workspace/SOUL.md` is missing
- **AND** the main `AgentRunner` attempts to construct the prompt
- **THEN** initialization SHALL fail with a configuration error

### Requirement: SOUL provides deployment identity and voice

The main Goblin system prompt SHALL include `$GOBLIN_HOME/workspace/SOUL.md` as the required deployment-owned identity and voice source. Runtime code MUST NOT inject a separate conversational agent name, user name, or private persona.

#### Scenario: SOUL included

- **WHEN** `$GOBLIN_HOME/workspace/SOUL.md` contains a deployed agent identity
- **THEN** the constructed system prompt SHALL include that content
- **AND** the runtime SHALL NOT add another agent name from config or source code

### Requirement: Deployment AGENTS provides optional operating rules

The main Goblin system prompt SHALL include `$GOBLIN_HOME/workspace/AGENTS.md` when it exists. Missing `$GOBLIN_HOME/workspace/AGENTS.md` SHALL NOT block `AgentRunner` initialization.

#### Scenario: AGENTS exists

- **WHEN** `$GOBLIN_HOME/workspace/AGENTS.md` exists
- **THEN** the constructed system prompt SHALL include it as deployment operating rules

#### Scenario: AGENTS missing

- **WHEN** `$GOBLIN_HOME/workspace/AGENTS.md` is missing
- **THEN** prompt construction SHALL continue using `SOUL.md` and the product shell

### Requirement: Product shell contains runtime mechanics only

The product shell SHALL be a small code-owned prompt scaffold for runtime mechanics such as Telegram channel behavior, tool truthfulness, destructive-action boundaries, section scoping, and memory-aside semantics. It MUST NOT contain deployed identity, user identity, conversational agent name, private persona, or negative anti-persona instructions.

#### Scenario: Product shell assembled

- **WHEN** the system prompt is constructed
- **THEN** it SHALL include runtime mechanics needed by the little-goblin process
- **AND** it SHALL NOT include a hardcoded deployed agent name or private user name

### Requirement: Goblin disables implicit context file loading

The main `AgentRunner` SHALL disable pi's implicit context-file loading and manually include only the prompt files allowed by Goblin's prompt builder.

#### Scenario: Global instruction file exists

- **WHEN** a global or compatibility instruction file exists outside `$GOBLIN_HOME` and the exact bound project file
- **THEN** the main Goblin system prompt SHALL NOT include that file

#### Scenario: Resource loader constructed

- **WHEN** the main `AgentRunner` constructs `DefaultResourceLoader`
- **THEN** it SHALL set `noContextFiles: true`

### Requirement: Memory remains per-turn context

The `AgentRunner` SHALL continue injecting memory snapshots as per-turn asides with `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })`. Memory snapshots MUST NOT be concatenated into the constructed system prompt.

#### Scenario: Prompt constructed once, memory loaded per turn

- **WHEN** an `AgentRunner` handles two user turns in the same session
- **THEN** the system prompt SHALL be constructed during session initialization
- **AND** the memory snapshot SHALL be loaded fresh and sent before each user prompt

### Requirement: AgentRunner schedules background memory reflection after completed turns

After a main-agent turn reaches `agent_end`, the `AgentRunner` SHALL advance the reflection cursor for that session to the current transcript end. It SHALL NOT schedule a non-blocking memory reflection pass. Reflection MUST NOT delay Telegram response flushing, MUST NOT run for `followUp()` events independently, and MUST NOT start while the turn is still streaming.

The per-turn reflection pass is replaced by the dreaming pipeline's light sleep phase, which SHALL run on a configurable interval (default 4 hours) via the scheduler. The `AgentRunner` SHALL continue to advance the reflection cursor after `agent_end` so that light sleep knows which transcript entries are new.

#### Scenario: Completed prompt advances cursor

- **WHEN** a main-agent prompt turn emits `agent_end`
- **THEN** the runner SHALL advance the reflection cursor for that session to the current transcript end
- **AND** user-visible turn completion SHALL not wait for any reflection work
- **AND** no per-turn reflection pass SHALL be scheduled

### Requirement: Reflection cursor prevents duplicate processing

The dreaming pipeline SHALL persist a cursor at `$GOBLIN_HOME/state/sessions/<id>/memory-dreaming-cursor.json` that records which transcript entries have been processed by light sleep. The cursor format SHALL be a line offset into `transcript.jsonl`. A light sleep pass SHALL process only transcript entries after the cursor, and SHALL advance the cursor only after candidate extraction, safety filtering, and persistence/quarantine complete without an unrecoverable error.

When light sleep first observes an existing session with no `memory-dreaming-cursor.json` file, it SHALL seed the cursor to the then-current end of `transcript.jsonl` before later completed turns are processed, and SHALL NOT process historical transcript entries from before that observation. This preserves the no-automatic-backfill rollout contract; historical transcript import requires a separate explicit backfill command outside this change.

The existing `memory-reflection.json` cursor SHALL be migrated to `memory-dreaming-cursor.json` on first observation: the cursor value (line offset) SHALL be preserved, the new file SHALL be written, and the old `memory-reflection.json` file SHALL be removed. Dreaming passes for the same session MUST be serialized in-process.

The `AgentRunner` SHALL advance the cursor after `agent_end` (marking transcript entries as eligible for the next light sleep pass). Light sleep SHALL advance the cursor again after processing (marking entries as consumed).

#### Scenario: Existing session seeds cursor before future light sleep

- **GIVEN** a session already has `transcript.jsonl` entries and no `memory-reflection.json`
- **WHEN** light sleep first observes that session after this feature is enabled
- **THEN** light sleep SHALL write a cursor at the current transcript end
- **AND** SHALL NOT extract candidates from the pre-existing transcript entries
- **AND** a later completed turn in the same session SHALL be eligible for light sleep because it occurs after the seeded cursor

#### Scenario: Existing memory-reflection.json cursor is migrated to dreaming cursor

- **GIVEN** a session already has a `memory-reflection.json` cursor at line 200 from the previous reflection system
- **WHEN** light sleep first observes that session after this feature is enabled
- **THEN** the existing cursor value SHALL be migrated to the dreaming cursor format (same line offset)
- **AND** light sleep SHALL process entries starting from line 201
- **AND** the `memory-reflection.json` file SHALL be removed or superseded by the dreaming cursor file

#### Scenario: Cursor advances after successful light sleep

- **WHEN** light sleep processes transcript entries 100-150 and all candidates are persisted or quarantined
- **THEN** the cursor SHALL advance to line 150
- **AND** the next light sleep pass SHALL start from line 151

#### Scenario: Failed light sleep retries same range

- **WHEN** light sleep fails before advancing the cursor
- **THEN** a later light sleep pass SHALL retry the same transcript range

#### Scenario: AgentRunner advances cursor on agent_end

- **WHEN** a main-agent turn reaches `agent_end` and the transcript has grown to line 200
- **THEN** the cursor SHALL be advanced to line 200
- **AND** the next light sleep pass SHALL process entries from the previous cursor position to line 200

### Requirement: Reflection uses scoped memory context

The dreaming pipeline SHALL resolve the same active memory scope as the user-facing turn. The dreaming session (`__goblin_dreaming__`, `chatId: 0`) is the dispatch vehicle for model turns, NOT the promotion target — its `ActiveScope` (`{ chatId: 0, topicScope: "general" }`) is never written to. Light sleep SHALL target the **originating transcript's** session active scope for promotions (e.g. a transcript snippet from session bound to topic 42 promotes into `topics/<chatId>/42`). REM and deep sleep SHALL aggregate across all scopes but promote each theme or short-term entry into the scope that originated it most frequently. The promotion rule is: for each theme or entry, collect its origin sessions; choose the scope with the highest session count; break ties by the most recent `updated_at`, then by scope name ascending. If the origin sessions are all from transcript scopes without a clear curated target, promote to `general`.

#### Scenario: Topic turn dreaming promotes into topic scope

- **WHEN** light sleep processes a transcript from a session in topic `42`
- **THEN** promoted entries SHALL be inserted with `scope = "topics/<chatId>/42"` and `entry_kind = "memory"`

#### Scenario: General turn dreaming promotes into general scope

- **WHEN** light sleep processes a transcript from a DM or supergroup-without-topic session
- **THEN** promoted entries SHALL be inserted with `scope = "general"` and `entry_kind = "memory"`

#### Scenario: REM sleep promotes a recurring theme to its dominant scope

- **GIVEN** the concept tag "backup" appears in transcript entries from sessions scoped to `topics/-100123/7` in 3 sessions and in `topics/-100123/11` in 1 session
- **WHEN** REM sleep detects "backup" as a recurring theme
- **THEN** the theme SHALL be promoted to `scope = "topics/-100123/7"` because it originated there most frequently

### Requirement: AgentRunner conditionally registers MCP tools

The `AgentRunner` constructor SHALL accept an optional `mcpRunner?: McpRunner`. When `mcpRunner` is present and `cfg.mcp` is defined, `buildCustomTools()` SHALL append the tools returned by `createMcpTools(this.mcpRunner)` to the array passed to `createAgentSession`. When `mcpRunner` is absent or `cfg.mcp` is undefined, no MCP tools SHALL be added.

The presence or absence of enabled/reachable MCP servers SHALL NOT affect whether `mcp_call` and `mcp_describe` are registered; an empty catalog or unreachable `mcporter` simply produces an empty or error-bearing tool surface. Caller-supplied `customTools` pass-through is governed by the existing `AgentRunner accepts session-bound custom tools` requirement in the agent canon and is not modified by this change.

#### Scenario: MCP runner present and config defined

- **WHEN** `AgentRunner` is constructed with `mcpRunner: runner` and `cfg.mcp` is defined
- **THEN** `buildCustomTools()` SHALL include the `mcp_call` and `mcp_describe` tools after the caller-supplied custom tools and memory tools

#### Scenario: MCP runner present with empty enabled list

- **WHEN** `AgentRunner` is constructed with `mcpRunner: runner` and `cfg.mcp` is `{ enabled: [] }`
- **THEN** `buildCustomTools()` SHALL still include `mcp_call` and `mcp_describe`
- **AND** the `mcp_call` description SHALL contain an empty catalog

#### Scenario: MCP runner absent

- **WHEN** `AgentRunner` is constructed without `mcpRunner`
- **THEN** `buildCustomTools()` SHALL NOT include `mcp_call` or `mcp_describe`

#### Scenario: MCP runner present but config absent

- **WHEN** `AgentRunner` is constructed with `mcpRunner: runner` but `cfg.mcp` is `undefined`
- **THEN** `buildCustomTools()` SHALL NOT include `mcp_call` or `mcp_describe`

### Requirement: AgentRunner records per-turn metrics

The `AgentRunner` SHALL record a `turn` metric event for every completed assistant turn. It SHALL compute `turnStart` from the `agent_start` event timestamp (or `prompt()` start when `agent_start` is not available), `turnEnd` from the `turn_end` event timestamp, and `durationMs` as the difference. It SHALL copy `usage`, `model`, `provider`, `api`, `responseModel`, `stopReason`, and `errorMessage` from the `turn_end` message. It SHALL count `toolCount` and `toolErrorCount` from `tool_execution_start` and `tool_execution_end` events that occur between the start and end of the turn. The event SHALL be written to the `MetricsStore` for the session.

#### Scenario: Assistant turn completes with usage

- **WHEN** `AgentRunner` handles a complete assistant turn with a `turn_end` containing `usage` and `stopReason`
- **THEN** a `turn` metric event SHALL be written to `metrics.jsonl`
- **AND** the event SHALL contain `durationMs`, `usage`, `cacheRead`, `cacheWrite`, `cost`, `toolCount`, `toolErrorCount`, and `stopReason`

#### Scenario: Tool error is counted

- **WHEN** a `tool_execution_end` event fires with `isError: true` during a turn
- **THEN** the `turn` event for that turn SHALL have `toolErrorCount` incremented by one

#### Scenario: Turn aborted before turn_end

- **WHEN** a turn is aborted and no `turn_end` arrives
- **THEN** no `turn` metric event SHALL be written
- **AND** any partial tool counts from the turn SHALL be discarded

### Requirement: AgentRunner provides MetricsStore to MemoryReflector

The `AgentRunner` SHALL pass a `MetricsStore` (or its session-scoped accessor) to `MemoryReflector` when constructing the default reflector. When a `MemoryReflector` is provided via `AgentRunnerOptions`, the `AgentRunner` SHALL NOT override it.

#### Scenario: Default MemoryReflector receives metrics

- **WHEN** `AgentRunner` is constructed without a `memoryReflector` option
- **THEN** the default `MemoryReflector` SHALL receive the `MetricsStore` for the runner's session

#### Scenario: Injected MemoryReflector is preserved

- **WHEN** `AgentRunner` is constructed with `memoryReflector` set
- **THEN** the provided `MemoryReflector` SHALL be used unchanged
- **AND** the runner SHALL NOT replace it with a new one

### Requirement: AgentRunner exposes metrics API on the runner

The `AgentRunner` SHALL expose a `metrics: MetricsStore` getter (or equivalent) so callers can record additional events for the session. The `MetricsStore` SHALL be available immediately after construction, before `init()` is called.

#### Scenario: Command handler records a counter

- **WHEN** `/debug` or another caller calls `runner.metrics.incrementCounter("manual", "session")`
- **THEN** the counter event SHALL be written to the current session's `metrics.jsonl`

#### Scenario: Metrics are available before the first prompt

- **WHEN** `AgentRunner` is constructed and `metrics` is accessed before `prompt()` is called
- **THEN** it SHALL return a `MetricsStore` bound to the runner's session

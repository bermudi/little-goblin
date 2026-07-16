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

The `AgentRunner` SHALL build a per-turn snapshot from the active memory scope (resolved from the runner's `(chatId, topicId)` or named-agent identity), the global `user.md`, and the cross-scope index, and inject it into the next turn via `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })` before each `prompt()` call. The snapshot MUST be loaded fresh for every turn so that writes performed in earlier turns or by completed reflection passes become visible on subsequent turns. The snapshot MUST NOT be added to pi's `_baseSystemPrompt`; whatever value `_baseSystemPrompt` holds at AgentSession creation MUST remain unchanged across turns by this change.

#### Scenario: Subsequent turn after reflection write

- **WHEN** background reflection writes a memory entry after turn N completes
- **AND** the user sends a new message that triggers turn N+1 in the same scope
- **THEN** the snapshot loaded for turn N+1 SHALL include the reflected entry

#### Scenario: System prompt unchanged across reflection writes

- **WHEN** any reflection pass changes memory files on disk between turns
- **THEN** `agent.state.systemPrompt` between turns SHALL remain equal to the value `_baseSystemPrompt` held at AgentSession creation

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include four memory tool definitions in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller:

1. `memory_read` — read the active scope, user.md, or any allowed cross-scope memory.
2. `memory_read_index` — list available topic and named-agent persona scopes with descriptions.
3. `memory_search` — search curated memory entries lexically and return ranked matches.
4. `memory_write` — mutate the active scope only.

The `memory_write` tool's `target` parameter SHALL be wired to resolve to a scope based on the runner's `(chatId, topicId)` or named-agent identity. The agent MUST NOT be given the ability to supply an arbitrary scope on writes. The `memory_search` tool SHALL use the same active scope and chat boundary as `memory_read_index` unless `all_chats` is explicitly requested. Persona scope eligibility for `memory_search` SHALL match the `memory_read_index` `agents` gating: the main goblin agent searches all persona scopes; a named subagent searches only its own persona scope; anonymous subagents search none.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `memory_read`, `memory_read_index`, `memory_search`, and `memory_write`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `topics/-100123/42/memory.md`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, plus the four memory tools

#### Scenario: Search tool uses active chat boundary

- **WHEN** a topic-bound runner exposes `memory_search`
- **THEN** a default search SHALL be limited to the runner's active chat plus global user/general memory

#### Scenario: Main agent searches all persona scopes

- **WHEN** the main goblin agent's runner exposes `memory_search`
- **THEN** default search SHALL include every `agents/<name>/memory.md` persona scope

#### Scenario: Named subagent searches own persona only

- **WHEN** a named subagent `researcher` exposes `memory_search`
- **THEN** default search SHALL include `agents/researcher/memory.md` and SHALL NOT include other persona scopes

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

After a main-agent turn reaches `agent_end`, the `AgentRunner` SHALL schedule a non-blocking memory reflection pass for that session. Reflection MUST NOT delay Telegram response flushing, MUST NOT run for `followUp()` events independently, and MUST NOT start while the turn is still streaming.

#### Scenario: Completed prompt schedules reflection

- **WHEN** a main-agent prompt turn emits `agent_end`
- **THEN** the runner SHALL schedule a background reflection pass for that session and active scope
- **AND** user-visible turn completion SHALL not wait for the reflection result

#### Scenario: Mid-turn steer does not schedule independent reflection

- **WHEN** `followUp()` steers a running turn
- **THEN** no separate reflection pass SHALL be scheduled for the follow-up itself
- **AND** the completed combined turn SHALL be eligible for one reflection pass at `agent_end`

### Requirement: Reflection cursor prevents duplicate processing

The memory reflection system SHALL persist a cursor under the session directory that records which transcript entries have been reflected. A reflection pass SHALL process only transcript entries after the cursor, and SHALL advance the cursor only after candidate extraction, safety filtering, and persistence/quarantine complete without an unrecoverable error.

When reflection first observes an existing session with no cursor file, it SHALL seed the cursor to the then-current end of `transcript.jsonl` before later completed turns are reflected, and SHALL NOT process historical transcript entries from before that observation. This preserves the no-automatic-backfill rollout contract; historical transcript import requires a separate explicit backfill command outside this change.

Reflection passes for the same session MUST be serialized in-process. If a second reflection schedule arrives while one is already running for that session, the system SHALL coalesce it into at most one follow-up pass after the current pass completes rather than running two passes against the same cursor concurrently.

#### Scenario: Existing session seeds cursor before future reflection

- **GIVEN** a session already has `transcript.jsonl` entries and no `memory-reflection.json`
- **WHEN** the runner or reflection system first observes that session after this feature is enabled
- **THEN** the reflection system SHALL write a cursor at the current transcript end
- **AND** it SHALL NOT extract candidates from the pre-existing transcript entries
- **AND** a later completed turn in the same session SHALL be eligible for reflection because it occurs after the seeded cursor

#### Scenario: First observation of new session reflects future turns only

- **GIVEN** a newly-created session has no reflection cursor
- **WHEN** reflection first observes it after a completed turn
- **THEN** that completed turn MAY be considered new work and reflected
- **AND** later passes SHALL process only entries after the cursor

#### Scenario: Overlapping schedules coalesce per session

- **WHEN** a reflection pass is already running for session `s1`
- **AND** another turn completion schedules reflection for `s1`
- **THEN** the second schedule SHALL NOT start a concurrent pass with the same cursor
- **AND** the system SHALL run at most one follow-up pass for `s1` after the current pass completes

#### Scenario: Restart after successful reflection

- **WHEN** a turn has already been reflected and Goblin restarts
- **THEN** the next reflection pass for that session SHALL skip the already-reflected transcript entries

#### Scenario: Failed reflection retries same range

- **WHEN** reflection fails before advancing the cursor
- **THEN** a later reflection pass SHALL retry the same transcript range

### Requirement: Reflection uses scoped memory context

The reflection pass SHALL resolve the same active memory scope as the user-facing turn and SHALL consider the current `user.md`, active `memory.md`, and cross-scope descriptions when deciding where and whether to persist candidates. Automatic reflection writes SHALL target only `user.md` or the active main-agent memory scope.

#### Scenario: Topic turn reflects into topic scope

- **WHEN** a completed turn occurred in topic `42`
- **THEN** automatic project/session facts from that turn SHALL be considered for `topics/<chat>/42/memory.md`
- **AND** stable user preferences SHALL be considered for `user.md`
- **AND** no other topic scope SHALL be written automatically

#### Scenario: General turn reflects into general scope

- **WHEN** a completed turn occurred in a DM or supergroup without topic
- **THEN** automatic non-user facts SHALL target `general/memory.md`

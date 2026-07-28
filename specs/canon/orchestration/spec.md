# orchestration

## Requirements

### Requirement: Build bot with middleware and command handlers

The system SHALL construct a grammy Bot instance with all middleware and handlers wired.

#### Scenario: Bot built

- **WHEN** `buildBot()` is called with a valid Config
- **THEN** it SHALL return `{ bot: Bot, manager: SessionManager }`
- **AND** the bot SHALL have allowlist middleware installed
- **AND** command handlers SHALL be registered

### Requirement: Install allowlist middleware before handlers

The system SHALL install the allowlist middleware before command handlers so all commands are protected.

#### Scenario: Middleware order

- **WHEN** `buildBot()` constructs the bot
- **THEN** `bot.use(buildAllowlistMiddleware(cfg))` SHALL be called before `registerCommands()`

### Requirement: Handle bot errors with structured logging

The system SHALL catch and log bot errors via `bot.catch()`.

#### Scenario: Bot error occurs

- **WHEN** an error is thrown in a handler
- **THEN** the error SHALL be logged via `log.error()` with fields: `name`, `message`, `updateId`

### Requirement: Initialize session manager

The system SHALL initialize the session manager before starting the bot.

#### Scenario: Startup sequence

- **WHEN** `main()` runs
- **THEN** `manager.init()` SHALL be called before `bot.start()`

### Requirement: Support graceful shutdown on signals

The system SHALL handle SIGINT and SIGTERM for graceful shutdown.

#### Scenario: SIGINT received

- **WHEN** the process receives SIGINT
- **THEN** `bot.stop()` SHALL be called
- **AND** after stop completes, the process SHALL exit with code 0

#### Scenario: SIGTERM received

- **WHEN** the process receives SIGTERM
- **THEN** `bot.stop()` SHALL be called
- **AND** after stop completes, the process SHALL exit with code 0

### Requirement: Log startup information

The system SHALL log key configuration at startup (without sensitive values).

#### Scenario: Bot starts

- **WHEN** `main()` starts the bot
- **THEN** it SHALL log: `goblinHome`, `allowedUsers` (count), `model`

### Requirement: Use long-polling for updates

The system SHALL use long-polling to receive updates, not webhooks.

#### Scenario: Bot starts

- **WHEN** `bot.start()` is called
- **THEN** it SHALL use grammy's long-polling mechanism (no webhook configuration)

### Requirement: Log bot identity on start

The system SHALL log the bot's username and ID when successfully connected.

#### Scenario: Bot connects

- **WHEN** the bot successfully connects to Telegram
- **THEN** it SHALL log: `bot online as @<username> (id <id>)`

### Requirement: Exit with error code on fatal errors

The system SHALL exit with non-zero code when main() throws.

#### Scenario: Fatal error in main

- **WHEN** `main()` throws an error
- **THEN** the error SHALL be logged via `log.error()`
- **AND** the process SHALL exit with code 1

### Requirement: Startup preflights Goblin prompt files

Startup SHALL validate Goblin prompt files before starting Telegram polling. Missing `$GOBLIN_HOME/workspace/SOUL.md` SHALL fail startup. Missing `$GOBLIN_HOME/workspace/AGENTS.md` SHALL produce a warning but SHALL NOT fail startup.

#### Scenario: SOUL missing at startup

- **WHEN** the process starts and `$GOBLIN_HOME/workspace/SOUL.md` is missing
- **THEN** startup SHALL fail before the bot starts polling Telegram
- **AND** the error SHALL use the shared prompt validation error contract telling the operator to run onboarding or create `SOUL.md` in `$GOBLIN_HOME/workspace/`

#### Scenario: AGENTS missing at startup

- **WHEN** the process starts and `$GOBLIN_HOME/workspace/AGENTS.md` is missing
- **THEN** startup SHALL log a warning
- **AND** the bot MAY continue if `SOUL.md` exists

### Requirement: Onboarding creates deployment prompt files

Onboarding SHALL create `$GOBLIN_HOME/workspace/SOUL.md` and `$GOBLIN_HOME/workspace/AGENTS.md` when missing. It MUST NOT overwrite existing files. When creating `SOUL.md`, onboarding SHALL ask for the conversational agent name and write it into a concise public-safe voice template.

#### Scenario: Fresh prompt setup

- **WHEN** onboarding runs and neither prompt file exists
- **THEN** onboarding SHALL ask for the conversational agent name
- **AND** write `$GOBLIN_HOME/workspace/SOUL.md` from the identity-plus-voice template
- **AND** write `$GOBLIN_HOME/workspace/AGENTS.md` from the modest operating-rules template

#### Scenario: Existing files preserved

- **WHEN** onboarding runs and `$GOBLIN_HOME/workspace/SOUL.md` or `$GOBLIN_HOME/workspace/AGENTS.md` already exists
- **THEN** onboarding SHALL NOT overwrite the existing file

#### Scenario: Existing AGENTS without SOUL

- **WHEN** onboarding runs and `$GOBLIN_HOME/workspace/AGENTS.md` exists but `$GOBLIN_HOME/workspace/SOUL.md` is missing
- **THEN** onboarding SHALL warn that existing `AGENTS.md` may contain old identity or voice content
- **AND** onboarding SHALL create a fresh `$GOBLIN_HOME/workspace/SOUL.md` template without copying content from `AGENTS.md`

### Requirement: Agent turns do not block unrelated updates

The system SHALL dispatch agent turns through the shared turn dispatcher without blocking unrelated Telegram updates. Serialization, runtime lifecycle, and stale-runtime guards SHALL be per conversation; rendering remains supplied by the surface adapter.

#### Scenario: Long turn does not block another conversation

- **WHEN** conversation A runs a long turn
- **AND** conversation B receives an update
- **THEN** B SHALL be processed without waiting for A

#### Scenario: Same conversation serializes

- **WHEN** two fresh turns target the same current conversation runtime
- **THEN** they SHALL serialize through that conversation's queue

### Requirement: Scheduler lifecycle follows bot lifecycle

The scheduler SHALL start during main startup after `SessionManager.init()` and SHALL stop during graceful shutdown before process exit. Scheduler failures SHALL be logged and SHALL NOT crash the bot unless initialization itself throws before the loop starts.

#### Scenario: Scheduler starts after manager init

- **WHEN** `main()` starts Goblin
- **THEN** `manager.init()` SHALL complete before the scheduler loop starts

#### Scenario: Scheduler stops on SIGTERM

- **WHEN** the process receives SIGTERM
- **THEN** the scheduler SHALL be stopped before process exit
- **AND** no new due schedules SHALL be dispatched after stop begins

#### Scenario: Tick error logged

- **WHEN** a scheduler tick encounters an unexpected error
- **THEN** the error SHALL be logged
- **AND** future ticks SHALL continue

### Requirement: Turn serialization lives in the orchestration layer

The `TurnDispatcher` SHALL continue to own conversation runtime creation, per-conversation prompt queues, and stale-runtime checks without importing Telegram modules. A surface adapter SHALL inject opaque sink and Telegram-tool factories, and construction SHALL require the narrow lifecycle-owned `SurfaceRuntimeAuthority` interface for current-binding assertion, synchronous stale checks, and attached-work exclusion. The dispatcher SHALL not retain a broad lifecycle mutation interface.

#### Scenario: Runtime is created

- **WHEN** the dispatcher creates a runtime for a bound conversation
- **THEN** it SHALL obtain current surface context through the injected read seam
- **AND** SHALL reject a stale conversation/surface pair

#### Scenario: Scheduler remains transport-agnostic

- **WHEN** a scheduled turn needs an output sink
- **THEN** the dispatcher SHALL obtain it from the injected surface sink factory
- **AND** the scheduler and dispatcher SHALL NOT import from `src/tg/`

### Requirement: Turn dispatcher runners map is encapsulated

The dispatcher SHALL keep its conversation-runtime map and prompt queues private and SHALL expose behavior-oriented methods keyed by conversation ID. Runtime disposal SHALL synchronously invalidate map/queue identity before awaiting runner and delegated-work cleanup so the stale-runtime guard takes effect immediately.

#### Scenario: Lifecycle invalidates a runtime

- **WHEN** the lifecycle module asks orchestration to dispose a conversation runtime
- **THEN** the runtime SHALL no longer be returned as current before asynchronous cleanup begins
- **AND** queued captures SHALL fail their current-runtime check

### Requirement: Agent self-scheduling tool has parity with /schedule

The main-agent `schedule_turn` tool SHALL manage schedules for the runtime's currently bound surface through the same store and time parsers as `/schedule`. It SHALL stamp provenance, enforce source authority, and return machine-readable schedule identifiers as before, but durable ownership and caps SHALL use `SurfaceId` rather than conversation ID. Subagents SHALL remain excluded.

#### Scenario: Agent creates a schedule

- **WHEN** a main conversation runtime on surface X calls `schedule_turn`
- **THEN** the schedule SHALL be owned by X
- **AND** later conversation rotation on X SHALL not alter or duplicate it

#### Scenario: Runtime is stale

- **WHEN** a runtime has been displaced from its surface before `schedule_turn` mutates the store
- **THEN** the tool call SHALL fail the current-binding check
- **AND** SHALL NOT create or mutate a schedule

### Requirement: Agent tool authority is scoped to agent-owned schedules

Agent schedule mutations SHALL remain limited to agent-owned records on the runtime's current surface. User schedule authority and redaction rules SHALL remain unchanged, and surface ownership SHALL be an additional required match.

#### Scenario: Cross-surface mutation is rejected

- **WHEN** an agent runtime on surface X attempts to mutate a schedule owned by Y
- **THEN** the store SHALL report no authorized match
- **AND** SHALL remain unchanged

### Requirement: Agent tool list redacts user-owned prompts

The agent tool's `list` action SHALL NOT return the `prompt` body of any schedule whose `source` is `"user"` into model context. User-owned schedules SHALL appear as redacted metadata only — at minimum `id`, `kind`, `state`, `nextRunAt`, and a marker indicating the schedule is user-owned and not agent-manageable — with the `prompt` field omitted or set to a sentinel such as `"<user-owned: not shown>"`. Agent-owned schedules SHALL be returned in full, including their `prompt`. This prevents prompt text the user authored (which may contain private or sensitive content) from being surfaced into an autonomous turn's context.

#### Scenario: List omits user prompt bodies

- **GIVEN** a session owns a user-created schedule with a prompt body and an agent-created schedule with a prompt body
- **WHEN** the agent calls `schedule_turn` with action `list`
- **THEN** the agent-created schedule SHALL include its full prompt
- **AND** the user-created schedule SHALL NOT include its prompt body
- **AND** the user-created schedule SHALL appear with id, kind, state, nextRunAt, and a user-owned marker

### Requirement: Schedule records carry provenance

Each surface-owned schedule SHALL retain optional `source: "user" | "agent"` provenance, with absent values treated as user-owned. Existing last-writer authority, user display annotation, and prompt-redaction behavior SHALL remain, independent of which conversation is currently bound.

#### Scenario: User claims an agent schedule after rotation

- **GIVEN** a surface owns an agent schedule and later rotates conversations
- **WHEN** the user mutates that schedule through `/schedule`
- **THEN** its source SHALL become `user`
- **AND** the current agent runtime SHALL not regain mutation authority

### Requirement: External-agent runs follow Goblin session lifecycle

The composition root SHALL construct one shared `ExternalAgentRunner` and supply it to turn dispatch and interrupt wiring. `TurnDispatcher.disposeRunner(sessionId)` SHALL invoke and await `ExternalAgentRunner.cancelBySession(sessionId)` during disposal, in addition to the pi-subagent cascade introduced by `cascade-cancel`. The method MUST NOT resolve until external-run cleanup has been attempted, even when no `AgentRunner` exists for the session.

Process shutdown SHALL stop the scheduler, dispose the external-agent runner, dispose the pi-subagent runner, dispose main agent runners, and stop Telegram polling before exit. External-agent cleanup failures SHALL be logged without skipping the remaining shutdown steps.

#### Scenario: Session disposal cancels external runs

- **WHEN** `disposeRunner("session-a")` is called
- **AND** session A owns two non-terminal external-agent runs
- **THEN** `cancelBySession("session-a")` SHALL be awaited
- **AND** both external runs SHALL be terminal before `disposeRunner` resolves unless their adapter cleanup failed after terminal marking

#### Scenario: Disposal without main runner still cleans delegated work

- **WHEN** `disposeRunner("session-a")` is called with no cached `AgentRunner`
- **AND** session A owns a non-terminal external-agent run
- **THEN** that external run SHALL still be cancelled

#### Scenario: Session disposal is isolated

- **WHEN** session A is disposed
- **AND** session B owns a running external-agent run
- **THEN** session B's run SHALL remain active

#### Scenario: Graceful process shutdown

- **WHEN** Goblin receives SIGINT or SIGTERM
- **THEN** the external-agent runner SHALL be disposed before process exit
- **AND** every non-terminal external run SHALL receive a cancellation attempt
- **AND** remaining runner and bot shutdown steps SHALL still execute if one external cleanup fails

### Requirement: Main AgentRunner receives session-bound external-agent tools

`TurnDispatcher.createRunner()` SHALL inject the shared `ExternalAgentRunner` and the session's resolved project directory into each main `AgentRunner`. During lazy tool assembly, `AgentRunner` SHALL register a session-bound `external_agent` tool only when external-agent configuration enables at least one backend. Pi subagents MUST NOT receive this tool.

External-run activity caused by the current tool call SHALL report coarse status through the current turn's `onStatusUpdate` callback. Background output after the `start` tool call returns SHALL be persisted for later `status` inspection and MUST NOT attempt to write directly to a stale Telegram buffer.

#### Scenario: Main agent gets tool

- **WHEN** a main runner initializes with at least one enabled external backend
- **THEN** its active tool names SHALL include `external_agent`
- **AND** the tool SHALL be bound to that runner's Goblin session id and resolved project directory

#### Scenario: Subagent tool set remains unchanged

- **WHEN** a pi subagent session is created
- **THEN** its custom tools MUST NOT include `external_agent`

#### Scenario: Start status uses current callback only

- **WHEN** `external_agent` starts a run during a main-agent turn
- **THEN** the current turn callback SHALL receive a coarse start status
- **AND** later background adapter output SHALL NOT retain or invoke that turn callback after the tool call returns

### Requirement: Scheduler dispatches dreaming phases

The scheduler SHALL dispatch three dreaming phases on independent configurable schedules:

- **Light sleep:** recurring interval, default 240 minutes. Dispatches a light sleep turn that scans recent transcripts, extracts candidates via subagent, and promotes novel snippets.
- **REM sleep:** recurring interval, default 1440 minutes (aligned to 03:00 local time on first run). Dispatches a REM sleep turn that detects recurring themes and promotes cross-session patterns.
- **Deep sleep:** recurring interval, default 1440 minutes (aligned to 04:00 local time on first run). Dispatches a deep sleep turn that promotes short-term entries to durable and runs budget compaction.

Each dreaming phase SHALL be dispatched as a model turn through the existing per-session queue (`TurnDispatcher.schedulePrompt`). The dreaming turns SHALL target a dedicated internal session identified by the constant session id `__goblin_dreaming__` (not a Telegram chat). The session SHALL be created lazily on first dispatch via `SessionManager.ensureInternal(id)`, SHALL use the reserved internal identity form, SHALL have `chatId: 0` and personal environment (sentinel — Telegram chat IDs are never 0), SHALL have no Telegram binding, and SHALL be excluded from `SessionManager.list()`. The dispatcher SHALL use `enqueueInternalTurn(internalSession, content, onComplete, onError)`, which accepts only validated internal state and rejects collision with a Surface-backed runner — no beta tools, no Telegram message buffer (a capture buffer accumulates the assistant's text), and an `onComplete(text)` return path so the dreaming pipeline can parse JSON candidates from the model's response. The per-session queue is shared with scheduled turns — no new dispatch infrastructure (see decision `0029-dreaming-internal-session-dispatch`).

Dreaming schedule intervals SHALL be expressed as a non-negative integer number of minutes or the literal `off` (case-insensitive); `0` is equivalent to `off`. Dreaming phases SHALL NOT be registered in `ScheduleStore` — they are system-internal timers managed by `SchedulerLoop` directly (via `clock.setInterval`), separate from the user-authored schedule tick. The phases SHALL be registered at startup. The intervals SHALL be configurable via `GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL`, `GOBLIN_MEMORY_DREAM_REM_INTERVAL`, and `GOBLIN_MEMORY_DREAM_DEEP_INTERVAL`. Setting any interval to `0` or `off` SHALL disable that phase.

For REM and deep sleep, the scheduler SHALL align the first run to the configured local time (03:00 for REM, 04:00 for deep) by computing the next occurrence of that time after startup. Subsequent runs SHALL be spaced by the configured interval. Light sleep SHALL start from the first tick after startup and repeat at the configured interval — no local-time alignment.

The scheduler SHALL NOT dispatch a dreaming phase while a previous dreaming phase for the same session is still running. Overlapping schedules SHALL coalesce into at most one follow-up dispatch.

#### Scenario: Light sleep dispatched on interval

- **GIVEN** light sleep is configured with a 240-minute interval
- **WHEN** the scheduler ticks and the interval has elapsed
- **THEN** a light sleep turn SHALL be dispatched to the dreaming session
- **AND** the turn SHALL be enqueued through the per-session queue
- **AND** the dreaming session id SHALL be `__goblin_dreaming__`
- **AND** the dreaming session SHALL have no Telegram `chatId` or `topicId`

#### Scenario: Dreaming phase disabled

- **GIVEN** `GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL=off`
- **WHEN** the scheduler ticks
- **THEN** no light sleep turn SHALL be dispatched
- **AND** the schedule SHALL not be registered

#### Scenario: Overlapping dreaming phases coalesce

- **GIVEN** a light sleep turn is running for the dreaming session
- **WHEN** the scheduler ticks and REM sleep is due
- **THEN** the REM sleep turn SHALL wait behind the light sleep turn via the per-session queue
- **AND** SHALL run after the light sleep turn completes

#### Scenario: REM sleep first run aligns to 03:00 local

- **GIVEN** goblin starts at 22:00 local time and REM sleep is configured with a 1440-minute interval
- **WHEN** the scheduler registers the REM schedule at startup
- **THEN** the first REM dispatch SHALL be scheduled for 03:00 local time (5 hours after startup)
- **AND** the second REM dispatch SHALL be 1440 minutes after the first (03:00 the next day)

#### Scenario: Dreaming does not block user turns

- **GIVEN** a dreaming turn is running for the dreaming session
- **WHEN** a user sends a message to a different session
- **THEN** the user's turn SHALL be processed immediately
- **AND** the dreaming turn SHALL continue without interruption

### Requirement: Transcript sync runs on scheduler interval

The scheduler SHALL dispatch a transcript sync tick on a configurable interval (default 5 minutes). The sync tick SHALL scan `$GOBLIN_HOME/state/sessions/*/transcript.jsonl` for changes since the last sync, reindex changed files into the memory SQLite database, and remove entries for deleted sessions.

The sync tick SHALL be dispatched as a lightweight scheduled task (not a full agent turn) — it does not require model invocation. The sync SHALL run in the scheduler loop and SHALL NOT block user turns or dreaming phases. The sync task SHALL yield between files and SHALL be bounded to a configurable maximum duration per tick (default 30 seconds); if the bound is exceeded, the remaining work SHALL resume on the next tick.

The sync interval SHALL be configurable via `GOBLIN_MEMORY_TRANSCRIPT_SYNC_INTERVAL` (minutes, default 5). Setting it to `0` SHALL disable transcript indexing.

#### Scenario: Changed transcript reindexed on sync tick

- **WHEN** the sync tick runs and a transcript file's mtime has changed since the last sync
- **THEN** the file SHALL be re-parsed, chunked, and embedded into `memory_entries`
- **AND** the `memory_sources` table SHALL be updated with the new mtime and hash

#### Scenario: Sync tick does not block user turns

- **GIVEN** a sync tick is running
- **WHEN** a user sends a message
- **THEN** the user's turn SHALL be processed without waiting for the sync to complete
- **AND** the sync SHALL continue in the background

#### Scenario: Transcript sync disabled

- **GIVEN** `GOBLIN_MEMORY_TRANSCRIPT_SYNC_INTERVAL=0`
- **WHEN** the scheduler ticks
- **THEN** no transcript sync SHALL run
- **AND** transcript entries SHALL NOT be indexed

#### Scenario: Long sync tick yields and resumes

- **GIVEN** a sync tick begins with 100 transcript files to process and the per-tick duration bound is 30 seconds
- **WHEN** the tick has processed 40 files after 30 seconds
- **THEN** the sync task SHALL yield and the remaining 60 files SHALL resume on the next tick
- **AND** user turns received during the sync SHALL be processed without waiting for sync completion

### Requirement: MCP runner is threaded through to AgentRunner

The `TurnDispatcher` SHALL accept an optional `mcpRunner?: McpRunner` via `TurnDispatcherOptions` and forward it to the `AgentRunner` constructor in `createRunner()`. The `TelegramIntake` SHALL accept an optional `mcpRunner?: McpRunner` via `TelegramIntakeOptions` and pass it to the `TurnDispatcher` constructor. The dispatcher SHALL NOT inspect or use the `McpRunner` directly; it is pure pass-through.

The composition root (`src/bot.ts`) SHALL construct the `McpRunner` from `cfg.mcp` and `cfg.goblinHome` and inject it into `createTelegramIntake`. When `cfg.mcp` is absent, no `McpRunner` is constructed and none is passed through.

#### Scenario: MCP runner threaded through to AgentRunner

- **WHEN** `TurnDispatcherOptions` includes `mcpRunner: runner`
- **AND** `createRunner()` constructs a new `AgentRunner`
- **THEN** the `AgentRunnerOptions` SHALL include `mcpRunner: runner`
- **AND** the resulting runner SHALL expose the `mcp_call` and `mcp_describe` tools when `cfg.mcp` is defined

#### Scenario: MCP runner absent from dispatcher options

- **WHEN** `TurnDispatcherOptions` does not include `mcpRunner`
- **THEN** `createRunner()` SHALL construct the `AgentRunner` without `mcpRunner`
- **AND** the resulting runner SHALL NOT expose MCP tools

#### Scenario: Telegram intake passes mcpRunner to dispatcher

- **WHEN** `TelegramIntake` is constructed with `mcpRunner: runner`
- **THEN** the `TurnDispatcher` it creates SHALL be constructed with `mcpRunner: runner`

#### Scenario: buildBot constructs mcpRunner from config

- **WHEN** `cfg.mcp` is defined
- **THEN** `buildBot` SHALL construct an `McpRunner` from `cfg.mcp` and `cfg.goblinHome`
- **AND** it SHALL pass that runner to `createTelegramIntake`
- **AND** the bot SHALL start normally

#### Scenario: buildBot omits mcpRunner when config absent

- **WHEN** `cfg.mcp` is `undefined`
- **THEN** `buildBot` SHALL NOT construct an `McpRunner`
- **AND** it SHALL pass `undefined` as the `mcpRunner` option to `createTelegramIntake`

### Requirement: Conversation runtime context comes from the current binding

A conversation runtime SHALL be keyed by conversation ID, but its Telegram tools, output sink, model and thinking preferences, and other surface context MUST be constructed from the conversation's current binding. Before runtime registration, orchestration SHALL obtain the dependency-provided immutable `CapturedMemoryContext` for that Surface and derive the dependency-provided Surface-backed `TranscriptWriterContext` from `CapturedMemoryContext.authority.sourceSurfaceId`. Every user-visible transcript write from the runtime SHALL use that closed-over writer context. Its CWD and pi history SHALL come from the conversation's immutable execution environment. A runtime MUST NOT be reused after its conversation moves to another surface.

#### Scenario: Resumed conversation gets destination context

- **GIVEN** a conversation previously ran on surface X
- **WHEN** it is resumed on compatible surface Y and next receives work
- **THEN** the new runtime SHALL use Y's tools, sink, captured memory context, model, and thinking preferences
- **AND** new user-visible transcript entries SHALL use Y's captured `TranscriptWriterContext`
- **AND** the runtime SHALL use the conversation's existing pi history and immutable execution environment

#### Scenario: Conversation is unbound

- **WHEN** orchestration is asked to create a user-visible runtime for an unbound conversation
- **THEN** it SHALL fail rather than invent or reuse surface context

### Requirement: Runtime disposal precedes binding movement

Before rotate, resume, or archive commits a binding change, orchestration SHALL remove and dispose every runtime made stale by the transition and sever its prompt queue. For rotation of a bound Surface, required quiescence SHALL complete before the fresh Conversation record is created. Moving a target from another surface SHALL dispose the target runtime; displacing the destination SHALL dispose the destination's prior runtime. At no time MAY one conversation have active runtimes for two surfaces.

#### Scenario: Resume displaces two runtimes

- **GIVEN** target conversation A has a runtime on X
- **AND** destination Y has conversation B with a runtime
- **WHEN** A is resumed on Y
- **THEN** A's runtime and B's runtime SHALL be removed from the runtime map and disposed before the binding commit
- **AND** no runtime for A SHALL remain associated with X

#### Scenario: Disposal fails

- **WHEN** required runtime disposal fails before a lifecycle transition commits
- **THEN** the binding transition SHALL fail
- **AND** existing bindings SHALL remain unchanged
- **AND** an invalidated runtime identity SHALL NOT be restored
- **AND** the failure SHALL be logged

#### Scenario: Rotate disposal fails before creation

- **GIVEN** Surface X is bound to Conversation P
- **WHEN** rotation cannot quiesce P's runtime
- **THEN** no fresh Conversation Q SHALL be created
- **AND** X SHALL remain bound to P
- **AND** a later dispatch SHALL construct a fresh runtime rather than reuse the invalidated object

### Requirement: Stale-runtime guard covers every lifecycle transition

Every queued prompt, deferred command, and scheduled turn SHALL capture its conversation runtime and verify that it is still current before each effect-producing phase. Rotation, resume, archive, and runtime replacement SHALL invalidate that capture by removing the runtime and severing the queue before binding mutation.

#### Scenario: Queued work loses its binding

- **GIVEN** work is queued behind a conversation runtime
- **WHEN** a lifecycle transition disposes that runtime before the work begins
- **THEN** the queued work SHALL stop before prompting pi, mutating lifecycle state, or producing Telegram output

### Requirement: Surface automation dispatches through the current conversation

The scheduler SHALL resolve a due schedule's surface binding at dispatch time and enqueue the prompt through that conversation's runtime and queue. It MUST NOT create a conversation for an unbound surface or use a conversation captured when the schedule was created.

#### Scenario: Conversation changed since schedule creation

- **GIVEN** a schedule was created while conversation A was bound
- **AND** conversation B is bound when the occurrence is due
- **WHEN** the scheduler dispatches the occurrence
- **THEN** it SHALL enqueue the turn through B's runtime
- **AND** SHALL NOT inspect or reactivate A

#### Scenario: Surface is unbound

- **WHEN** the occurrence is due but the surface has no binding
- **THEN** orchestration SHALL create no runtime and no conversation
- **AND** the occurrence SHALL remain pending

### Requirement: Scheduler dispatches due turns through the current Conversation queue

The single-process scheduler SHALL poll surface-owned schedules at the existing 60-second default interval, inspect each due record's current surface binding without creating a conversation, and claim the occurrence only when a bound conversation is eligible for dispatch. It SHALL enqueue through the same per-conversation queue used by Telegram and `/queue`. An unbound occurrence SHALL stay due and enabled. Existing one-at-a-time claiming, recurrence advancement, failure logging, and scheduler lifecycle behavior SHALL remain.

#### Scenario: Due surface dispatches to current conversation

- **GIVEN** a due schedule whose surface is currently bound to conversation B
- **WHEN** the scheduler ticks
- **THEN** it SHALL claim the occurrence and enqueue a fresh turn through B's queue

#### Scenario: Unbound occurrence is not claimed

- **GIVEN** a due schedule whose surface is unbound
- **WHEN** the scheduler ticks
- **THEN** it SHALL not advance, complete, or disable the occurrence
- **AND** SHALL emit an observable pending-unbound signal without creating a conversation

#### Scenario: Binding changes before queued work starts

- **GIVEN** a due occurrence was enqueued through conversation B
- **WHEN** B's runtime is displaced before the turn starts
- **THEN** the stale-runtime guard SHALL drop the captured work before effects

### Requirement: Agent-originated schedules are bounded by a per-Surface cap

The enabled agent-schedule cap SHALL be enforced per surface at the store mutation seam for create, resume, and heartbeat-enable transitions. `MAX_AGENT_SCHEDULES` SHALL retain its default of 8. User schedules and disabled/completed agent schedules SHALL remain excluded from the count, and human `/schedule` operations SHALL remain uncapped. A mutation that would exceed the cap SHALL fail atomically, leave the store unchanged, and return a cap-exceeded error identifying the limit.

#### Scenario: Create at cap fails atomically

- **GIVEN** a Surface has `MAX_AGENT_SCHEDULES` enabled agent-owned schedules
- **WHEN** its runtime attempts to create or re-enable another agent-owned schedule
- **THEN** the mutation SHALL fail with a cap-exceeded error identifying the limit
- **AND** the schedule store SHALL remain unchanged

#### Scenario: Human schedule remains uncapped

- **GIVEN** a Surface is at the agent schedule cap
- **WHEN** the user creates or resumes a schedule through `/schedule`
- **THEN** the human-authorized mutation SHALL not be rejected by `MAX_AGENT_SCHEDULES`

#### Scenario: Conversation rotation does not reset cap

- **GIVEN** a surface is at `MAX_AGENT_SCHEDULES`
- **WHEN** its conversation rotates
- **THEN** the next runtime on that surface SHALL still be at the cap

### Requirement: Disposing a Conversation runtime cancels compatibility-owned delegated work

Disposing a conversation runtime SHALL dispose the `AgentRunner`, immediately remove runtime and queue identity, and invoke existing delegated-work cleanup using the conversation ID through compatibility ownership methods. This change SHALL NOT redefine attached/detached work ownership. `cancelPending` SHALL continue not to cascade.

#### Scenario: Runtime disposal uses compatibility ownership

- **WHEN** conversation `abc123def0` is disposed
- **THEN** orchestration SHALL call existing `cancelBySession("abc123def0")` compatibility methods after invalidating the runtime
- **AND** SHALL NOT reinterpret or migrate delegated-work ownership

#### Scenario: Pending cancellation remains non-cascading

- **WHEN** only a queued prompt is cancelled while the conversation remains active
- **THEN** delegated work SHALL continue

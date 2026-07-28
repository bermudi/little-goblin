# commands

## Requirements

### Requirement: Register command handlers on bot

The system SHALL register command handlers in two locations, both derived from `COMMAND_REGISTRY` in `src/commands/registry.ts`: pure-helper commands (`/ping`, `/start` — defs with a `grammyHandler`) via grammy's `bot.command()` middleware in `registerCommands()`, and session-affecting commands (defs with a `handler`) inline in the `message:text` handler in `bot.ts` so they share timing semantics and can run even when no session is bound. `registerCommands()` SHALL iterate the `grammy` defs and call `bot.command(name, grammyHandler(...))` for each — no command name SHALL be hardcoded in `registerCommands()`.

#### Scenario: Bot initialized

- **WHEN** `registerCommands()` is called with a Bot instance and SessionManager
- **THEN** it SHALL register a `bot.command()` handler for every def in `COMMAND_REGISTRY` that has a `grammyHandler`
- **AND** session-affecting commands (defs with a `handler`) SHALL be routed by `bot.ts`'s `message:text` handler via `handleCommand()`

### Requirement: Command timing classification

Every command in `COMMAND_REGISTRY` SHALL declare when it runs relative to an in-flight turn: `instant`, `queue`, or `interrupt`. `/compact` SHALL be queue-timing, so it defers behind an active turn instead of aborting it.

#### Scenario: Compact is queue-timing

- **WHEN** the bot is initialized
- **THEN** `/compact` SHALL resolve to queue timing

### Requirement: Implement /ping command

The system SHALL provide a `/ping` command that responds with user and chat information.

#### Scenario: /ping in DM

- **WHEN** a user sends `/ping` in a private chat
- **THEN** the bot SHALL reply with: `pong 🐲\nuser: <userId>\nchat: private`

#### Scenario: /ping in topic

- **WHEN** a user sends `/ping` in a forum topic
- **THEN** the bot SHALL reply with: `pong 🐲\nuser: <userId>\nchat: <type>\ntopic: <topicId>`
- **AND** the reply SHALL be sent to the correct topic thread

### Requirement: Handle /start in forum topic

`/start` in a topic SHALL use the same non-creating welcome/status behavior as every other supported surface and SHALL address the topic through its canonical `Surface` value.

#### Scenario: Start in an unbound topic

- **WHEN** `/start` is sent in an unbound topic
- **THEN** it SHALL NOT claim that a conversation already exists
- **AND** SHALL NOT create one

### Requirement: Handle indeterminate chat context for /start

The system SHALL handle cases where chat context cannot be determined for `/start`.

#### Scenario: /start with no locator

- **WHEN** `locatorFromCtx()` returns `null` for a `/start` command
- **THEN** the bot SHALL reply with: `Unable to determine chat context.`

### Requirement: Cancel command aborts current turn immediately

`/cancel` is the sole interrupt-timing command. It SHALL call `interruptAndCascade` itself (not via a dispatch pre-check), which calls `AgentRunner.abort()`, cascades to live pi subagents, and cancels non-terminal external-agent runs owned by the active Goblin session. Its reply SHALL be computed from the expanded cascade result for honest reporting.

#### Scenario: Cancel during streaming

- **WHEN** `/cancel` is sent while Goblin is streaming
- **THEN** `runner.abort()` SHALL be called via `interruptAndCascade`
- **AND** live pi subagents belonging to the session SHALL be aborted
- **AND** non-terminal external-agent runs owned by the session SHALL be cancelled
- **AND** a `Cancelled` reply SHALL be sent

#### Scenario: Cancel when main agent is idle but external work is running

- **WHEN** `/cancel` is sent while Goblin is idle
- **AND** the active session owns a running external-agent run
- **THEN** that external-agent run SHALL be cancelled
- **AND** a `Cancelled` reply SHALL be sent rather than `Nothing to cancel`

#### Scenario: Cancel when nothing is active

- **WHEN** `/cancel` is sent while the main agent is idle
- **AND** the active session owns no running subagent or external-agent run
- **THEN** it SHALL succeed without error
- **AND** a `Nothing to cancel` reply SHALL be sent

#### Scenario: Cancel with no active session

- **WHEN** `/cancel` is sent in a DM with no active session
- **THEN** a `Nothing to cancel` reply SHALL be sent

### Requirement: Debug command dumps diagnostics

`/debug` SHALL run immediately and report the active conversation ID and optional name using `Conversation:` and `Conversation Name:` labels. It SHALL report surface-owned model/thinking settings and automation separately from conversation-owned creation time, transcript, metrics, pi context, and immutable execution environment.

#### Scenario: Named conversation

- **WHEN** `/debug` is invoked for a conversation named `ttt-v2`
- **THEN** output SHALL contain `Conversation: <id>` followed by `Conversation Name: ttt-v2`

#### Scenario: Unbound surface

- **WHEN** `/debug` is invoked on an unbound surface
- **THEN** it SHALL report that no active conversation exists without creating one

### Requirement: Subagents command lists tracked runner entries

The `/subagents` command SHALL list subagents currently tracked by the in-process `SubagentRunner`. If none are tracked, it SHALL reply that no subagents are tracked.

#### Scenario: Subagents list

- **WHEN** `/subagents` is sent while subagents are tracked
- **THEN** the reply SHALL include each tracked subagent id, role, status, spawn time, optional name, and optional spawner id

#### Scenario: No tracked subagents

- **WHEN** `/subagents` is sent while no subagents are tracked
- **THEN** the reply SHALL say `No subagents tracked.`

### Requirement: Cancel subagent command cancels one tracked subagent

The `/cancel_subagent <id>` command SHALL cancel the subagent with the supplied id via `SubagentRunner.cancel()`.

#### Scenario: Cancel subagent

- **WHEN** `/cancel_subagent abc123` is sent
- **THEN** `SubagentRunner.cancel("abc123")` SHALL be invoked
- **AND** a success reply SHALL be shown

#### Scenario: Cancel subagent without id

- **WHEN** `/cancel_subagent` is sent without an id
- **THEN** a usage reply SHALL be shown

### Requirement: Revive command revives a persisted subagent

The `/revive <id> <prompt>` command SHALL revive the subagent with the supplied id via `SubagentRunner.revive()`. The prompt is required because revival sends a follow-up turn into the persisted subagent conversation.

#### Scenario: Revive with explicit prompt

- **WHEN** `/revive abc123 inspect again` is sent
- **THEN** `SubagentRunner.revive("abc123", "inspect again")` SHALL be invoked
- **AND** the final subagent response SHALL be included in the reply

#### Scenario: Revive without prompt

- **WHEN** `/revive abc123` is sent without a prompt
- **THEN** a usage reply SHALL be shown
- **AND** `SubagentRunner.revive()` MUST NOT be invoked

#### Scenario: Revive without id

- **WHEN** `/revive` is sent without an id
- **THEN** a usage reply SHALL be shown

### Requirement: Cancel cascades to all live subagents

`/cancel` is the sole interrupt-timing command; it SHALL abort the main agent, every live pi subagent in the active session's spawn tree, and every non-terminal external-agent run owned by that session. State-mutating queue-timing commands SHALL defer behind the turn instead of invoking the interrupt cascade; when they later dispose the old session runner, disposal SHALL clean up remaining delegated work through the orchestration lifecycle.

#### Scenario: Cancel kills main agent and delegated work

- **WHEN** `/cancel` is sent while Goblin is streaming
- **AND** the active session owns running pi subagents and external-agent runs
- **THEN** all such delegated work SHALL be cancelled
- **AND** the main agent SHALL be aborted
- **AND** a `Cancelled` reply SHALL be sent

#### Scenario: Cancel with only external work

- **WHEN** `/cancel` is sent while Goblin is idle with no pi subagents
- **AND** the active session owns a running external-agent run
- **THEN** the external-agent run SHALL be cancelled
- **AND** the command SHALL report cancellation

#### Scenario: Other sessions are isolated

- **WHEN** `/cancel` is sent in session A
- **AND** session B owns running pi subagents or external-agent runs
- **THEN** session B's work SHALL remain active

#### Scenario: State-mutating commands do not use interrupt cascade

- **WHEN** `/new` is sent while delegated work is running
- **THEN** `/new` SHALL defer behind the active turn rather than invoking `interruptAndCascade`
- **AND** delegated work may continue until the turn finishes and old-session disposal begins

### Requirement: State-mutating commands queue behind the current turn

Queue-timing commands SHALL defer behind an in-flight turn rather than aborting it. If an earlier queued continuation swaps out the runner, later continuations for the stale runner SHALL be dropped by the current-runner guard. `/cancel` is the sole exception: it interrupts.

A runtime whose main-agent abort timed out is not a queue owner: its outstanding prompt may never settle. `/new` and `/archive` SHALL bypass that runtime's queue and invoke their lifecycle transitions directly, so lifecycle invalidation fences the wedged runtime before durable authority changes. Other queue-timing commands SHALL return the existing recovery guidance instead of acknowledging work that cannot run.

#### Scenario: Archive after timed-out abort

- **GIVEN** the active runtime's abort timed out and its prompt remains unsettled
- **WHEN** `/archive` is sent
- **THEN** it SHALL NOT reply that the command is queued
- **AND** it SHALL invalidate the runtime, clear the binding, and archive the Conversation

#### Scenario: Rapid command spam

- **WHEN** `/new` then `/archive` are sent in quick succession while a turn is streaming
- **THEN** each SHALL defer behind the turn (not abort it)
- **AND** once the turn settles, `/new` SHALL execute first and bind a fresh session
- **AND** `/archive` SHALL be dropped because its captured runner is no longer current
- **AND** the fresh session SHALL remain bound

### Requirement: Cascade cancel is bounded by a timeout

`/cancel`'s cascade SHALL bound each individual main-agent abort, pi-subagent cancel, and external-run cancel by a per-call timeout (default 5 seconds). A target whose cancellation does not resolve within the timeout SHALL be reported in the cascade summary so the user-facing reply is honest about what may still be running. The helper MUST NOT issue `kill -9`; an external adapter may still perform its own specified graceful-then-forceful child-process teardown within its `cancel()` implementation.

#### Scenario: Stuck external run does not block command

- **WHEN** `/cancel` is sent and an external run's `cancel()` never resolves
- **THEN** the cascade SHALL stop waiting for that run after the timeout
- **AND** cancellation of other targets SHALL still be attempted
- **AND** the reply SHALL report one timed-out external run

#### Scenario: Stuck subagent does not block command

- **WHEN** `/cancel` is sent and a pi subagent's `cancel()` never resolves
- **THEN** the cascade SHALL stop waiting on that subagent after the timeout
- **AND** the command SHALL still complete within bounded time
- **AND** the reply SHALL report the timed-out subagent

#### Scenario: Stuck main agent does not prevent delegated-work cancellation

- **WHEN** `/cancel` is sent and the main runner's `abort()` never resolves
- **THEN** the cascade SHALL stop waiting on the main runner after the timeout
- **AND** pi-subagent and external-run cancellation SHALL still run
- **AND** the reply SHALL acknowledge the stuck main agent

### Requirement: Help command lists available commands

`/help` SHALL continue to derive its output from `COMMAND_REGISTRY`, and every description SHALL use the canonical lifecycle terms. Existing command names and aliases SHALL remain unchanged.

#### Scenario: Lifecycle commands in help

- **WHEN** `/help` is sent
- **THEN** `/new`, `/archive`, `/name`, `/resume`, `/debug`, `/compact`, `/queue`, `/voice`, and `/schedule` descriptions SHALL refer to conversations or surfaces as appropriate

### Requirement: Name and resume use the timing classification

`/name` SHALL remain instant-timing and `/resume` SHALL remain queue-timing. A deferred resume SHALL execute only while its captured runtime is still current; otherwise the stale-runtime guard SHALL drop it before lifecycle mutation.

#### Scenario: Resume during active turn

- **WHEN** `/resume <target>` is sent while the current runtime is streaming
- **THEN** it SHALL defer without aborting the turn
- **AND** SHALL move the binding only after the turn settles and the runtime is disposed

### Requirement: Help command lists name and resume

The `/help` command SHALL list `/name <name>` and `/resume <id-or-name>` in the available command list.

#### Scenario: Help output includes session management commands

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/name`
- **AND** the reply SHALL include `/resume`

### Requirement: Compact command triggers manual context compaction

The `/compact` command is queue-timing. If a turn is in flight, it SHALL defer behind it (acking "Queued.") so the runner is idle before compaction rewrites the transcript. It SHALL invoke `AgentRunner.compact()`, and reply with the result. Optional trailing text SHALL be forwarded as `customInstructions` to pi's compaction (e.g. `/compact focus on the database schema decisions`).

If no conversation is bound to the chat, the reply SHALL be "No active conversation to compact."

If the conversation exists but has nothing to compact (pi throws), the reply SHALL include the error message from pi (e.g. "Nothing to compact (conversation too small).").

If compaction succeeds, the reply SHALL include `tokensBefore` from the result (formatted as e.g. `"Compacted from ~42K tokens."`).

#### Scenario: Compact an active conversation

- **WHEN** `/compact` is sent in a chat with an active conversation that has multiple turns of history
- **AND** the agent is idle (not streaming)
- **THEN** `runner.compact()` SHALL be called
- **AND** a reply SHALL include the tokens-freed count (e.g. `"Compacted from ~42K tokens."`)

#### Scenario: Compact during active turn

- **WHEN** `/compact` is sent while the agent is streaming
- **THEN** the command SHALL be deferred behind the current turn (not aborted)
- **AND** an instant "Queued." ack SHALL be sent
- **AND** `runner.compact()` SHALL be called once the turn settles
- **AND** a reply SHALL be sent with the compaction result

#### Scenario: Compact with custom instructions

- **WHEN** `/compact focus on the schema decisions` is sent
- **THEN** `runner.compact("focus on the schema decisions")` SHALL be called

#### Scenario: Nothing to compact

- **WHEN** `/compact` is sent and the conversation has minimal history
- **THEN** a reply SHALL indicate the conversation is too small to compact (pi's error message)

#### Scenario: No active conversation

- **WHEN** `/compact` is sent in a DM with no active conversation
- **THEN** a reply SHALL say `"No active conversation to compact."`

### Requirement: Command dispatch is Telegram-side-effect-free

The command dispatch in `bot.ts`'s `message:text` handler SHALL be implemented as `handleCommand(opts: DispatchOpts): Promise<DispatchResult>` exported from `src/commands/dispatch.ts`. The function SHALL resolve the command token via `resolveCommand()` from `src/commands/registry.ts`; if no def matches or the def has no `handler` (i.e. a grammy-only def), it SHALL return `{ kind: "fallthrough" }`. `/cancel` SHALL own its own interrupt cascade inside its handler; dispatch itself SHALL call `def.handler(...)` without a timing pre-check. The function may call command executors that mutate session state through `SessionManager`, but it MUST NOT mutate the grammy `Context`, MUST NOT call `bot.api.*` methods, MUST NOT receive or touch the `agentRunners` map, and MUST NOT call `runner.dispose()` on any existing runner. It returns a structured result describing the Telegram replies and runner lifecycle side effects the caller must apply.

The `DispatchResult` for `kind: "replied"` SHALL include an optional `tag` field of type `SystemTag` (`"ok" | "error" | "warn" | "info" | "queued"`), defaulting to `"ok"` when omitted. The caller SHALL use this tag when sending the reply via `sendSystemReply`. Command handlers SHALL set `tag` to reflect the semantic category of their reply: `"error"` for failures, `"warn"` for config issues and soft warnings, `"info"` for usage text and state feedback, `"queued"` for queue acks.

#### Scenario: Dispatch takes deps as a parameter

- **WHEN** `handleCommand` is invoked
- **THEN** it SHALL receive a `Deps` object that includes the `manager`, `subagentRunner`, `cfg`, and a `tryResolveModel` helper
- **AND** it SHALL receive an `interruptAndCascade` reference that can be overridden in tests
- **AND** the `Deps` object SHALL be the only way the function reaches into the bot's wiring state

#### Scenario: Dispatch returns side effects, not direct mutations

- **WHEN** `handleCommand` is invoked with a dispatched command (e.g. `/new`, `/archive`, `/model`)
- **THEN** the returned `DispatchResult.reply` SHALL be the text to send back to the user
- **AND** the returned `DispatchResult.tag` SHALL indicate the semantic category for formatting
- **AND** the returned `DispatchResult.sideEffects` SHALL describe runner-map mutations the caller must perform (e.g. `runner-created`, `runner-disposed`)
- **AND** the function itself SHALL NOT mutate `runners`, SHALL NOT call `runner.dispose()`, and SHALL NOT send a `ctx.reply` — the caller does that

#### Scenario: Unknown command returns fallthrough

- **WHEN** `handleCommand` is invoked with a command that resolves to no def (or a grammy-only def with no `handler`)
- **THEN** the returned `DispatchResult.kind` SHALL be `"fallthrough"`
- **AND** the caller SHALL continue to normal agent routing

#### Scenario: Cancel owns cascade interrupt

- **WHEN** `handleCommand` is invoked for `/cancel`
- **THEN** the `/cancel` handler SHALL call the injected `interruptAndCascade` with the existing runner (if any), the subagent runner, the cascade timeout, and the session id
- **AND** the cascade `CascadeResult` SHALL be used for honest timeout reporting in the reply text

#### Scenario: Dispatch is testable in isolation

- **WHEN** a unit test constructs a `Deps` bundle with fake `manager`, fake `subagentRunner`, and a stubbed `interruptAndCascade`
- **THEN** `handleCommand` SHALL execute the dispatch logic without requiring a real grammy `Bot` instance, a real `SubagentRunner`, or any `bot.api.*` calls
- **AND** the test SHALL assert on the returned `DispatchResult` (reply text, tag, and side-effect list)

#### Scenario: Error handler sets error tag

- **WHEN** a command handler catches an exception and returns a "Failed to ..." reply
- **THEN** the `DispatchResult.tag` SHALL be `"error"`

#### Scenario: Usage reply sets info tag

- **WHEN** a command handler returns a usage string (e.g. `"Usage: /queue <text>"`)
- **THEN** the `DispatchResult.tag` SHALL be `"info"`

#### Scenario: Queue ack sets queued tag

- **WHEN** the `/queue` handler returns `"Queued. Will run after the current turn."`
- **THEN** the `DispatchResult.tag` SHALL be `"queued"`
- **AND** when the runner is idle and the handler returns `"Running."`, the tag SHALL be `"ok"`

### Requirement: Queue command enqueues text for the next idle turn

The `/queue <text>` command is instant-timing. It SHALL enqueue the supplied text via the per-Conversation promise queue so it runs as a fresh turn via `AgentRunner.prompt()` only after the current turn (and any prior queued work) settles. It SHALL NOT abort the running turn.

If no `<text>` is supplied, the reply SHALL be `"Usage: /queue <text>"` with `tag: "info"` and nothing SHALL be enqueued.

If no conversation is bound to the chat, the reply SHALL be `"No active conversation."` with `tag: "info"` and nothing SHALL be enqueued.

If the runner is idle when `/queue` is handled, the supplied text SHALL run immediately as a fresh turn (the queue is empty, so the work starts now).

#### Scenario: Queue behind a running turn

- **WHEN** `/queue then check the tests` is sent while goblin is streaming
- **THEN** the text `"then check the tests"` SHALL be enqueued via the per-Conversation promise queue
- **AND** the running turn SHALL NOT be aborted
- **AND** a reply SHALL acknowledge the queue with `tag: "queued"` (e.g. `"Queued. Will run after the current turn."`)

#### Scenario: Queue when idle runs immediately

- **WHEN** `/queue then check the tests` is sent while goblin is idle
- **THEN** the text SHALL run as a fresh turn immediately via `AgentRunner.prompt()`
- **AND** the reply SHALL be `"Running."` with `tag: "ok"`

#### Scenario: Queue without text

- **WHEN** `/queue` is sent without a trailing argument
- **THEN** the reply SHALL be `"Usage: /queue <text>"` with `tag: "info"`
- **AND** nothing SHALL be enqueued

#### Scenario: Queue with no active conversation

- **WHEN** `/queue do something` is sent in a DM with no active conversation
- **THEN** the reply SHALL be `"No active conversation."` with `tag: "info"`
- **AND** nothing SHALL be enqueued

### Requirement: Queue command does not interrupt the running turn

The `/queue` command SHALL NOT abort the running turn or cascade to subagents. It appends to the per-session queue behind the running turn, it does not interrupt it.

#### Scenario: Queue does not abort a running turn

- **GIVEN** an active session whose runner is streaming
- **WHEN** `/queue do this after` is sent
- **THEN** `interruptAndCascade` SHALL NOT be invoked
- **AND** `runner.abort()` SHALL NOT be called
- **AND** the running turn SHALL continue

### Requirement: Help command lists queue

The `/help` command SHALL list `/queue <text>` in the available command list.

#### Scenario: Help output includes queue

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/queue <text>`

### Requirement: Voice command converts last assistant message to speech

The `/voice` and `/v` commands SHALL read the most recent assistant message from the conversation's `transcript.jsonl`, generate an MP3 voice file via Microsoft Edge TTS, and feed a synthetic prompt to the model instructing it to call `send_voice` with the generated audio path. The command is instant-timing: it runs immediately and does not abort or defer the current turn.

#### Scenario: Voice command with a prior assistant message

- **WHEN** `/voice` is sent in a chat with an active conversation that has at least one completed assistant turn
- **AND** the agent is idle (not streaming)
- **THEN** the last assistant entry in `transcript.jsonl` SHALL be read
- **AND** the text content SHALL be extracted (from string or content-block array)
- **AND** `uvx edge-tts` SHALL be invoked with the text (via a temp file with `--file`), `--voice <VOICE_NAME>`, and `--write-media <tmpPath>`
- **AND** a synthetic prompt SHALL be dispatched to the agent: the audio path and instructions to use `send_voice`
- **AND** the model SHALL call `send_voice(voiceFile=<tmpPath>, ...)` to deliver the voice message

#### Scenario: Voice command during active stream

- **WHEN** `/voice` is sent while the agent is streaming
- **THEN** the running turn SHALL NOT be aborted (instant-timing)
- **AND** the last completed assistant message (from the transcript, not the in-progress partial) SHALL be used
- **AND** voice generation SHALL proceed as in the idle case

#### Scenario: Voice command with no assistant messages

- **WHEN** `/voice` is sent in a conversation that has no assistant entries in `transcript.jsonl`
- **THEN** the bot SHALL reply with text: "No messages to voice yet."

#### Scenario: Voice command with no active conversation

- **WHEN** `/voice` is sent in a DM with no active conversation
- **THEN** the bot SHALL reply with text: "No active conversation. Use /new to start one."

#### Scenario: Edge TTS subprocess fails

- **WHEN** `uvx edge-tts` exits with a non-zero code or is not available
- **THEN** the bot SHALL reply with text: `Voice generation failed: <error>` where `<error>` is the subprocess stderr or exit code
- **AND** no synthetic prompt SHALL be dispatched

#### Scenario: Shorthand /v alias

- **WHEN** `/v` is sent
- **THEN** it SHALL behave identically to `/voice`

#### Scenario: Assistant message has only non-text content blocks

- **WHEN** the last assistant message has only thinking, toolCall, or image content blocks (no text blocks)
- **THEN** `readLastAssistantMessage` SHALL return `null`
- **AND** the bot SHALL reply with text: "No messages to voice yet."

### Requirement: Voice command uses configurable Edge TTS voice

The voice used for Edge TTS synthesis SHALL be configurable via the `VOICE_NAME` environment variable, defaulting to `en-US-EmmaMultilingualNeural`. The configured voice name SHALL be passed as the `--voice` argument to `uvx edge-tts`.

#### Scenario: Default voice (no env var)

- **WHEN** `VOICE_NAME` is not set
- **THEN** `uvx edge-tts --voice en-US-EmmaMultilingualNeural` SHALL be used

#### Scenario: Custom voice via env var

- **WHEN** `VOICE_NAME=en-US-AndrewMultilingualNeural` is set
- **THEN** `uvx edge-tts --voice en-US-AndrewMultilingualNeural` SHALL be used

### Requirement: Voice command cleans up temporary audio files

The temporary MP3 file created by Edge TTS SHALL be deleted after the `send_voice` tool completes, or immediately if voice generation fails. Temporary files SHALL be created under the system temp directory (`os.tmpdir()`).

#### Scenario: Successful voice delivery

- **WHEN** the model calls `send_voice` with the generated audio path and it succeeds
- **THEN** the temporary file SHALL be deleted after the tool invocation completes

#### Scenario: Failed voice generation

- **WHEN** Edge TTS or the synthetic prompt flow fails
- **THEN** the temporary file SHALL be deleted before the error reply is sent

### Requirement: Voice command dispatches synthetic prompt through normal agent routing

The `/voice` command SHALL NOT call `bot.api.sendVoice` directly. It SHALL generate the audio file and then dispatch the instruction to use `send_voice` as a normal turn through the agent runner's `prompt()` method, using the same MessageBuffer setup as any user message. The synthetic prompt SHALL instruct the model to call `send_voice` with the audio file path and SHALL explicitly tell the model not to repeat or describe the content — the audio IS the message.

#### Scenario: Synthetic prompt instructs model not to repeat content

- **WHEN** the synthetic prompt is dispatched after voice generation
- **THEN** it SHALL contain the audio file path
- **AND** it SHALL instruct the model to call `send_voice`
- **AND** it SHALL explicitly state that the audio already contains the message, so the model MUST NOT repeat or describe the content in text

#### Scenario: Model sends voice with caption

- **WHEN** the synthetic prompt is dispatched after voice generation
- **THEN** the model MAY include an optional caption in its `send_voice` call
- **AND** the `send_voice` tool handler SHALL deliver the voice message to the chat

### Requirement: Command registry is single source of truth

The system SHALL maintain a single `COMMAND_REGISTRY: readonly CommandDef[]` in `src/commands/registry.ts` as the source of truth for every slash command. Each `CommandDef` SHALL carry: canonical `name` (without leading slash), `description`, optional `aliases`, optional `argsHint`, a `timing` classification, and exactly one of `handler` (a `CommandHandler` dispatched from the `message:text` path) or `grammyHandler` (a factory producing a grammy command handler registered via `bot.command()`).

Every consumer of the command set SHALL derive its data from `COMMAND_REGISTRY`:

- `HELP_REPLY` SHALL be built from each def's `name`, `argsHint`, and `description`.
- `resolveTiming()` SHALL derive instant, queue, or interrupt behavior from each def's `timing` field.
- `registerCommands()` SHALL iterate the `grammy` defs and call `bot.command(name, grammyHandler(...))` for each.
- `handleCommand()` SHALL resolve the command token via `resolveCommand()` and call `def.handler(...)` for dispatched commands.
- The Telegram `setMyCommands` payload SHALL be derived from the registry.

Adding a new command SHALL require exactly one `CommandDef` entry. Adding an alias SHALL require only extending the `aliases` tuple on the existing `CommandDef`. No other file SHALL need editing for either operation (beyond the handler implementation itself for a new command).

#### Scenario: Adding a command is one entry

- **WHEN** a new slash command `/foo` is added
- **THEN** exactly one `CommandDef` entry SHALL be added to `COMMAND_REGISTRY`
- **AND** `HELP_REPLY`, `resolveTiming()`, `registerCommands()` (if grammy), `handleCommand()` dispatch, and the Telegram menu SHALL all reflect the new command without any further edits

#### Scenario: Adding an alias is one tuple edit

- **WHEN** an alias `/f` is added to an existing command `/foo`
- **THEN** only the `aliases` tuple on the `/foo` `CommandDef` SHALL change
- **AND** `resolveCommand("/f")` SHALL resolve to the `/foo` def
- **AND** `HELP_REPLY` and the Telegram menu SHALL update automatically

#### Scenario: No duplicate names or aliases

- **WHEN** `COMMAND_REGISTRY` is loaded
- **THEN** no two defs SHALL share the same `name`
- **AND** no alias SHALL collide with another def's `name` or alias
- **AND** a registry validation test SHALL fail the build on any collision

#### Scenario: Every def has exactly one handler kind

- **WHEN** `COMMAND_REGISTRY` is loaded
- **THEN** every def SHALL have exactly one of `handler` or `grammyHandler`
- **AND** every def SHALL declare a `timing` classification

#### Scenario: Resolve command by name or alias

- **WHEN** `resolveCommand("/voice")` or `resolveCommand("/v")` is called
- **THEN** both SHALL resolve to the same `CommandDef` with `name: "voice"`
- **AND** `resolveCommand("voice")` (without leading slash) SHALL also resolve to the same def
- **AND** `resolveCommand("/unknown")` SHALL return `null`

### Requirement: Telegram command menu is populated at startup

The system SHALL call `bot.api.setMyCommands()` once at startup with a `BotCommand[]` derived from `COMMAND_REGISTRY`. Each entry SHALL use a sanitized command name (lowercase, hyphens replaced with underscores, ≤32 characters, matching `^[a-z][a-z0-9_]{0,31}$`) and the def's `description` (truncated to 256 characters). Aliases SHALL be excluded — one menu entry per canonical command. The call SHALL be best-effort: on failure, the system SHALL log a warning and continue startup without aborting.

#### Scenario: Menu populated from registry

- **WHEN** the bot starts successfully
- **THEN** `setMyCommands` SHALL be called with one `BotCommand` per non-grammy def plus grammy defs
- **AND** each `BotCommand.command` SHALL be the sanitized canonical name (no aliases)
- **AND** each `BotCommand.description` SHALL be the def's description

#### Scenario: setMyCommands failure is non-fatal

- **WHEN** `setMyCommands` rejects (e.g. network error, rate limit)
- **THEN** the system SHALL log a warning with the error
- **AND** the bot SHALL continue starting and remain functional (commands still dispatch via `message:text`)

### Requirement: Schedule command manages explicit scheduled turns

The instant-timing `/schedule` command SHALL create, list, remove, pause, and resume schedules owned by the invoking surface rather than by its current conversation. Schedule management SHALL remain available while the surface is unbound; a newly due occurrence on an unbound surface remains pending. Existing source authority, time grammar, and display behavior SHALL be preserved.

#### Scenario: Schedule survives new and resume

- **GIVEN** a surface owns a schedule
- **WHEN** `/new` or `/resume` changes the bound conversation
- **THEN** `/schedule list` SHALL show the same schedule
- **AND** no schedule record SHALL be copied or retargeted

#### Scenario: Manage schedule while unbound

- **WHEN** `/schedule list`, `pause`, `resume`, or `remove` is sent on an unbound surface
- **THEN** it SHALL operate on that surface's schedules without creating a conversation

### Requirement: Schedule command parses bounded time expressions

The `/schedule` command SHALL accept a small documented set of time expressions: absolute ISO-8601 timestamps for `at`, `in <duration>` for one-shot relative schedules, and duration strings for `every`. Durations SHALL accept integer values with units `m`, `h`, or `d`. Invalid or past times SHALL produce a usage reply and SHALL NOT create a schedule.

#### Scenario: Relative one-shot schedule

- **WHEN** `/schedule in 30m stretch your legs` is sent
- **THEN** Goblin SHALL create a one-shot schedule due approximately 30 minutes after command handling

#### Scenario: Invalid duration rejected

- **WHEN** `/schedule every soon check backups` is sent
- **THEN** Goblin SHALL reply with usage information
- **AND** SHALL NOT create a schedule

#### Scenario: Past absolute time rejected

- **WHEN** `/schedule at 2000-01-01T00:00:00Z check backups` is sent
- **THEN** Goblin SHALL reject the schedule as being in the past

#### Scenario: Invalid ISO timestamp rejected

- **WHEN** `/schedule at not-a-timestamp check backups` is sent
- **THEN** Goblin SHALL reply with usage information
- **AND** SHALL NOT create a schedule

#### Scenario: Invalid relative duration rejected

- **WHEN** `/schedule in soon stretch your legs` is sent
- **THEN** Goblin SHALL reply with usage information
- **AND** SHALL NOT create a schedule

### Requirement: Schedule command manages heartbeat

`/schedule heartbeat` SHALL manage the invoking surface's explicit heartbeat record and surface-specific prompt configuration. Heartbeat SHALL remain disabled by default, use the existing 30-minute default, and survive conversation rotation, movement, archive, and temporary lack of a binding.

#### Scenario: Heartbeat status after rotation

- **GIVEN** heartbeat is enabled for a surface
- **WHEN** `/new` rotates its conversation
- **THEN** `/schedule heartbeat status` SHALL report the same interval and next run

### Requirement: Command handlers strip legacy emoji prefixes

Command handlers and intake message-reply strings SHALL NOT include the `❌` emoji prefix in reply text sent via `message.reply` or `sendSystemReply`. The monospaced tag prefix from `sendSystemReply` replaces emoji as the visual distinction for system messages. Existing reply strings that contain `❌` SHALL have the emoji and any surrounding whitespace stripped before the string is passed to `sendSystemReply`. Guest-mode inline query articles (`article()` calls using `⏳` and `⚠️`) are NOT affected — they use a different delivery path (`answerGuestQuery`).

#### Scenario: Error reply without emoji

- **WHEN** a command handler or intake path sends an error reply via `message.reply` or `sendSystemReply`
- **THEN** the reply text SHALL NOT start with `❌`
- **AND** the `sendSystemReply` helper SHALL prepend `` `[error]` `` as the tag

#### Scenario: Guest-mode articles are not affected

- **WHEN** a guest-mode inline query produces a busy or error article
- **THEN** the `⏳` and `⚠️` emoji in `article()` calls SHALL be preserved
- **AND** these articles SHALL NOT pass through `sendSystemReply`

### Requirement: Commands use conversation terminology

Command descriptions, help, diagnostics, status text, errors, and success replies SHALL use “conversation” for Goblin's durable history. They MUST NOT use “session” for a surface, binding, conversation, or conversation runtime; references to pi's `AgentSession` and retained compatibility/path names are exempt.

#### Scenario: Help is rendered

- **WHEN** `/help` lists lifecycle, model, compact, queue, voice, or schedule commands
- **THEN** descriptions that refer to durable Goblin history SHALL say “conversation”

#### Scenario: Missing binding is reported

- **WHEN** a command requires a bound conversation but the surface is unbound
- **THEN** its reply SHALL say “No active conversation” rather than “No active session”

### Requirement: Commands inspect before creating

Slash-command dispatch SHALL inspect the current surface binding without invoking ordinary-message resolve-or-start. Only `/new` and dependency-owned commands whose explicit contract creates a conversation may create one; status, listing, mutation, and unknown commands MUST NOT accidentally create a conversation.

#### Scenario: Status command on an unbound surface

- **WHEN** `/start`, `/debug`, `/archive`, `/name`, or a listing command is sent on an unbound surface
- **THEN** command dispatch SHALL observe no current conversation
- **AND** SHALL NOT create one as a side effect of resolution

### Requirement: Model and thinking commands update the Surface

`/model` and `/think` SHALL read and write preferences for the invoking Surface rather than the bound Conversation. A bound runtime MAY apply the preference immediately, but the persisted value SHALL survive `/new`, `/resume`, and `/archive` and SHALL be used by the next runtime on that Surface. These commands MUST NOT create a Conversation when invoked on an unbound Surface.

#### Scenario: Model survives new

- **WHEN** the user selects a model on a Surface and then runs `/new`
- **THEN** the fresh Conversation's runtime SHALL use the same Surface model preference

#### Scenario: Resumed conversation adopts destination thinking

- **GIVEN** a compatible Conversation is resumed onto a Surface with a thinking preference
- **WHEN** its runtime is created
- **THEN** it SHALL use the destination Surface's thinking preference

#### Scenario: Preference on unbound Surface

- **WHEN** `/model` or `/think` is used on an unbound Surface
- **THEN** it MAY update that Surface's preference without creating a Conversation

### Requirement: Start command reports Surface conversation status

The system SHALL provide `/start` as a welcome and current-status command on supported surfaces. It SHALL inspect the current binding without creating or rotating a conversation. On an unbound surface it SHALL explain that the next ordinary message will start a conversation and that `/new` can start one explicitly.

#### Scenario: Start with active conversation

- **WHEN** `/start` is sent on a surface with a bound conversation
- **THEN** the reply SHALL welcome the user and include the active conversation ID
- **AND** no binding or conversation state SHALL change

#### Scenario: Start on an unbound DM

- **WHEN** `/start` is sent on an unbound DM surface
- **THEN** no conversation SHALL be created
- **AND** the reply SHALL explain that the user can send a message or use `/new`

### Requirement: New command rotates the Surface to a fresh Conversation

The queue-timing `/new` command SHALL rotate the invoking surface to a fresh conversation in that surface's effective execution environment. The previous conversation SHALL remain unarchived, unbound, and resumable; model/thinking preferences, schedules, and heartbeat configuration SHALL remain on the surface. The command MUST NOT mutate topic UI.

#### Scenario: New during active turn

- **WHEN** `/new` is sent while the current conversation is running a turn
- **THEN** it SHALL immediately acknowledge `Queued.` and defer behind that turn
- **AND** the lifecycle module SHALL dispose the old runtime before committing the rotation
- **AND** queued work captured by the old runtime SHALL fail the stale-runtime guard

#### Scenario: New with prior conversation

- **WHEN** `/new` is sent on a surface with a bound conversation
- **THEN** a fresh conversation SHALL be created and bound to the same surface and environment
- **AND** the prior conversation SHALL remain resumable
- **AND** the reply SHALL include the new conversation ID

#### Scenario: New fails while quiescing prior runtime

- **GIVEN** the Surface is bound to Conversation P
- **WHEN** `/new` cannot quiesce P's runtime
- **THEN** the command SHALL report failure
- **AND** no fresh Conversation SHALL be created
- **AND** P SHALL remain bound and resumable without reusing the invalidated runtime object

#### Scenario: New on an unbound surface

- **WHEN** `/new` is sent on an unbound supported surface
- **THEN** a fresh conversation SHALL be created and bound

### Requirement: New command preserves the prior resumable Conversation

`/new` SHALL create a fresh resumable conversation through the lifecycle module and SHALL leave the prior conversation available to compatible `/resume` lookup. It SHALL NOT directly edit bindings, archive the prior conversation, or coordinate runner side effects in the command caller.

#### Scenario: Prior conversation remains resumable

- **WHEN** `/new` rotates away from a named conversation
- **THEN** `/resume` lookup on a surface with the same execution environment SHALL still include that conversation

### Requirement: Archive command queues and archives the current Conversation

The queue-timing `/archive` command SHALL ask the lifecycle module to dispose the current conversation runtime, atomically clear its binding, and then move the conversation directory to `state/sessions/archive/<id>/`. It SHALL leave surface settings, schedules, heartbeat configuration, and Telegram topic UI unchanged. The next authorized ordinary message on the surface SHALL lazily start a fresh conversation.

#### Scenario: Archive during streaming

- **WHEN** `/archive` is sent while a turn is running
- **THEN** it SHALL immediately acknowledge `Queued.` and defer until the turn settles
- **AND** archive through the lifecycle module

#### Scenario: Archive leaves surface automation

- **WHEN** a bound conversation is archived on a surface with enabled schedules
- **THEN** the surface SHALL become unbound
- **AND** the schedules SHALL remain enabled and pending without creating a conversation

#### Scenario: Archive with no conversation

- **WHEN** `/archive` is sent on an unbound surface
- **THEN** the reply SHALL say `No active conversation to archive.`

#### Scenario: Archive storage move fails

- **WHEN** the lifecycle module clears the binding but cannot move the Conversation directory
- **THEN** `/archive` SHALL report failure
- **AND** the Conversation SHALL remain unbound, unarchived, and resumable
- **AND** surface settings and automation SHALL remain unchanged

### Requirement: Name command persists the bound Conversation name

The instant-timing `/name <name>` command SHALL persist the current conversation's name. It SHALL require a bound conversation and SHALL use conversation terminology in usage, success, and error replies.

#### Scenario: Name without argument

- **WHEN** `/name` is sent without a Conversation name
- **THEN** the reply SHALL be exactly `Usage: /name <conversation name>`
- **AND** no Conversation record SHALL change

#### Scenario: Name current conversation

- **WHEN** `/name memory refactor` is sent on a bound surface
- **THEN** the bound conversation's name SHALL become `memory refactor`
- **AND** the reply SHALL include its conversation ID and name

#### Scenario: Name unbound surface

- **WHEN** `/name memory refactor` is sent on an unbound surface
- **THEN** the reply SHALL say `No active conversation to name.`

### Requirement: Resume command binds the Surface to a resumable Conversation

The queue-timing `/resume <id-or-name>` command SHALL resolve exact ID, unique ID prefix, or exact name among non-archived conversations compatible with the destination surface's effective execution environment. A compatible target active elsewhere SHALL be atomically moved to the destination after its old runtime and the destination's displaced runtime are disposed. An incompatible, missing, or ambiguous target MUST leave bindings and runtimes unchanged. Missing targets SHALL be reported. Ambiguous matches SHALL list matching Conversation IDs and names. Without a target, the command SHALL list named compatible Conversations and SHALL explicitly report when none exist.

#### Scenario: Resume compatible unbound conversation

- **WHEN** `/resume <target>` uniquely selects an unbound compatible conversation
- **THEN** the lifecycle module SHALL bind it to the destination
- **AND** the destination's prior conversation SHALL remain stored and resumable

#### Scenario: Resume moves conversation from another surface

- **GIVEN** the target is active on compatible surface X
- **WHEN** `/resume <target>` is sent on surface Y
- **THEN** the target runtime on X and displaced runtime on Y SHALL be disposed before one atomic binding move
- **AND** the target SHALL be bound only to Y

#### Scenario: Resume incompatible conversation

- **WHEN** the target exists but its immutable execution environment differs from the destination's effective environment
- **THEN** `/resume` SHALL report the incompatibility
- **AND** SHALL NOT dispose a runtime or change a binding

#### Scenario: Resume target is missing

- **WHEN** `/resume <target>` matches no compatible non-archived Conversation
- **THEN** the reply SHALL report that no Conversation was found for the target
- **AND** bindings and runtimes SHALL remain unchanged

#### Scenario: Resume target is ambiguous

- **WHEN** `/resume <target>` matches several compatible Conversations
- **THEN** the reply SHALL report ambiguity and list each matching Conversation ID and name
- **AND** bindings and runtimes SHALL remain unchanged

#### Scenario: Resume without target

- **WHEN** `/resume` is sent without a target
- **THEN** it SHALL list only named, non-archived conversations compatible with the invoking surface
- **AND** SHALL identify them as conversations

#### Scenario: Resume without target and no named Conversations

- **WHEN** `/resume` is sent and no named compatible Conversation exists
- **THEN** the reply SHALL say that no named Conversations exist yet

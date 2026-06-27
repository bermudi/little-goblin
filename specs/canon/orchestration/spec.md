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

Startup SHALL validate Goblin prompt files before starting Telegram polling. Missing `$GOBLIN_HOME/SOUL.md` SHALL fail startup. Missing `$GOBLIN_HOME/AGENTS.md` SHALL produce a warning but SHALL NOT fail startup.

#### Scenario: SOUL missing at startup

- **WHEN** the process starts and `$GOBLIN_HOME/SOUL.md` is missing
- **THEN** startup SHALL fail before the bot starts polling Telegram
- **AND** the error SHALL use the shared prompt validation error contract telling the operator to run onboarding or create `SOUL.md`

#### Scenario: AGENTS missing at startup

- **WHEN** the process starts and `$GOBLIN_HOME/AGENTS.md` is missing
- **THEN** startup SHALL log a warning
- **AND** the bot MAY continue if `SOUL.md` exists

### Requirement: Onboarding creates deployment prompt files

Onboarding SHALL create `$GOBLIN_HOME/SOUL.md` and `$GOBLIN_HOME/AGENTS.md` when missing. It MUST NOT overwrite existing files. When creating `SOUL.md`, onboarding SHALL ask for the conversational agent name and write it into a concise public-safe voice template.

#### Scenario: Fresh prompt setup

- **WHEN** onboarding runs and neither prompt file exists
- **THEN** onboarding SHALL ask for the conversational agent name
- **AND** write `SOUL.md` from the identity-plus-voice template
- **AND** write `AGENTS.md` from the modest operating-rules template

#### Scenario: Existing files preserved

- **WHEN** onboarding runs and `SOUL.md` or `AGENTS.md` already exists
- **THEN** onboarding SHALL NOT overwrite the existing file

#### Scenario: Existing AGENTS without SOUL

- **WHEN** onboarding runs and `AGENTS.md` exists but `SOUL.md` is missing
- **THEN** onboarding SHALL warn that existing `AGENTS.md` may contain old identity or voice content
- **AND** onboarding SHALL create a fresh `SOUL.md` template without copying content from `AGENTS.md`

### Requirement: Agent turns do not block unrelated updates

Telegram message handlers SHALL schedule normal agent work without waiting for the work promise to settle, so one busy agent turn or slow media pre-processing step does not hold grammy's global update handling path. Scheduled work SHALL stop before user-visible side effects when its runner is no longer the active runner for that session.

For non-command text messages on a session whose runner is currently streaming, the bot SHALL steer the message into the running turn via `AgentRunner.followUp()` rather than enqueue it. The update handler SHALL resolve as soon as the `followUp` call is dispatched (it does not await the turn's completion). The in-flight `MessageBuffer` continues to render the same turn; no new status line or response bubble is created for the steered message itself.

If the turn ends between the `isStreaming` check and the `followUp` call (a race), `followUp` SHALL throw an error containing "not streaming" and the bot SHALL fall back to scheduling a fresh turn via `schedulePrompt` + `AgentRunner.prompt()` with a new `MessageBuffer`. The message MUST NOT be silently dropped — it lands as a new turn instead of a steer.

For non-command text messages on a session whose runner is idle, the bot SHALL schedule a new turn via `AgentRunner.prompt()`. Same-session turns that do not overlap (the runner is idle when the next message arrives) SHALL remain ordered: the second SHALL NOT start until the first settles.

For `/queue <text>` commands, the bot SHALL serialize the supplied text via the per-session promise queue so it runs as a fresh turn only after the current turn (and any prior queued work) settles. This is the only path that uses the queue for text.

Media messages (photo, document, voice) SHALL continue to serialize via the per-session promise queue regardless of streaming state, because `followUp` is text-only in this change.

#### Scenario: Busy turn releases the update handler

- **GIVEN** an active session whose runner prompt remains pending
- **WHEN** a non-command text message is handled
- **THEN** the Telegram update handler SHALL resolve before the runner prompt settles

#### Scenario: Steer reaches a busy runner

- **GIVEN** an active session whose runner is streaming
- **WHEN** a non-command text message is handled for that session
- **THEN** the bot SHALL call `runner.followUp(text)` without awaiting the turn's completion
- **AND** the in-flight `MessageBuffer` SHALL continue to render the same turn
- **AND** no new status message or response bubble SHALL be created for the steered message

#### Scenario: Steer race falls back to a fresh turn

- **GIVEN** an active session whose runner is streaming when the bot checks `isStreaming`
- **WHEN** the turn ends between the `isStreaming` check and the `runner.followUp(text)` call
- **THEN** `followUp` SHALL throw an error containing "not streaming"
- **AND** the bot SHALL fall back to `schedulePrompt` + `runner.prompt(text, newBuffer)` so the message runs as a fresh turn
- **AND** the message SHALL NOT be silently dropped

#### Scenario: Cancel reaches a busy runner

- **GIVEN** an active session whose runner prompt remains pending
- **WHEN** `/cancel` is handled for that session
- **THEN** the command SHALL reach the active runner and reply without waiting for the pending prompt to settle

#### Scenario: Slow media pre-processing releases the update handler

- **GIVEN** an active session whose media download remains pending
- **WHEN** a media message is handled
- **THEN** the Telegram update handler SHALL resolve before the media download settles

#### Scenario: Stale media work does not side-effect

- **GIVEN** an active session whose scheduled media download remains pending
- **WHEN** a runner-disposing command replaces the session runner before the download finishes
- **THEN** the stale media work SHALL NOT save files, reply, or prompt the replaced runner after the download returns

#### Scenario: Overlapping same-session text is steered

- **GIVEN** an active session whose runner is idle
- **WHEN** a non-command text message arrives, starts a turn, and a second non-command text message arrives while the first turn is still streaming
- **THEN** the second message SHALL be steered into the running turn via `followUp` (not enqueued as a separate turn)

#### Scenario: Non-overlapping same-session turns remain ordered

- **GIVEN** an active session whose first turn has settled (runner is idle again)
- **WHEN** a second non-command text message arrives for the same session
- **THEN** the second SHALL start as a fresh turn via `AgentRunner.prompt()`
- **AND** it SHALL NOT start before the first turn settles (the per-session promise queue enforces ordering)

#### Scenario: /queue serializes behind a running turn

- **GIVEN** an active session whose runner is streaming
- **WHEN** `/queue do this after you finish` is handled
- **THEN** the supplied text SHALL be enqueued via the per-session promise queue
- **AND** it SHALL NOT start until the current turn and any prior queued work settle
- **AND** it SHALL run as a fresh turn via `AgentRunner.prompt()` (with a new `MessageBuffer` and memory snapshot)

#### Scenario: /queue when idle runs immediately

- **GIVEN** an active session whose runner is idle
- **WHEN** `/queue do this` is handled
- **THEN** the supplied text SHALL run as a fresh turn via `AgentRunner.prompt()` without waiting

#### Scenario: Media message while streaming serializes

- **GIVEN** an active session whose runner is streaming
- **WHEN** a photo message is handled
- **THEN** the photo download and prompt SHALL be enqueued via the per-session promise queue
- **AND** it SHALL NOT start until the current turn settles

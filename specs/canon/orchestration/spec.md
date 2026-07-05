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

The Telegram intake module (`src/tg/intake.ts`) SHALL schedule normal agent work without waiting for the work promise to settle, so one busy agent turn or slow media pre-processing step does not hold grammy's global update handling path. `src/bot.ts` SHALL remain a thin grammy adapter: its `bot.on(...)` handlers SHALL delegate to intake methods and SHALL NOT own scheduling, steer, queue, media-download, ASR, or scheduled-turn dispatch logic themselves. Scheduled work SHALL stop before user-visible side effects when its runner is no longer the active runner for that session.

For non-command text messages on a session whose runner is currently streaming, intake SHALL steer the message into the running turn via `AgentRunner.followUp()` rather than enqueue it. For `/queue <text>`, media messages, and scheduler-dispatched prompts, work SHALL serialize via the per-session promise queue as fresh turns.

#### Scenario: Scheduler work is not Telegram update work

- **WHEN** a due scheduled prompt is dispatched
- **THEN** no grammy update handler SHALL be required
- **AND** unrelated Telegram updates SHALL continue to be handled while the scheduled turn runs

#### Scenario: Scheduled turn while streaming serializes

- **GIVEN** an active session whose runner is streaming
- **WHEN** a scheduled prompt becomes due for that session
- **THEN** the scheduled prompt SHALL be enqueued via the per-session promise queue
- **AND** SHALL NOT start until the current turn and prior queued work settle

### Requirement: Scheduler dispatches due turns through the per-session queue

The system SHALL run a single-process scheduler loop after session manager initialization and before or alongside Telegram long-polling. The scheduler SHALL poll the schedule store for due enabled schedules at a 60-second default interval, claim each due schedule one at a time within a tick before dispatch, and enqueue the scheduled prompt as a fresh turn through the same per-session queue used by `/queue` and media prompts.

#### Scenario: Due schedule queues fresh turn

- **GIVEN** an enabled schedule whose `nextRunAt` is in the past
- **AND** its captured session remains bound to its captured locator
- **WHEN** the scheduler ticks
- **THEN** it SHALL enqueue the schedule's prompt as a fresh turn for that session
- **AND** SHALL NOT call `AgentRunner.followUp()`

#### Scenario: Busy session waits behind current turn

- **GIVEN** a due schedule for a session whose runner is currently streaming
- **WHEN** the scheduler ticks
- **THEN** the scheduled prompt SHALL wait behind the in-flight turn via the per-session prompt queue
- **AND** SHALL run as a fresh turn after prior queued work settles

#### Scenario: Overlapping ticks do not double-dispatch

- **GIVEN** a schedule is due
- **WHEN** two scheduler ticks overlap
- **THEN** at most one tick SHALL claim and dispatch that due occurrence

#### Scenario: One-shot schedule disables after run

- **WHEN** a one-shot schedule is successfully claimed for dispatch
- **THEN** it SHALL be disabled or marked complete before the prompt runs
- **AND** it SHALL NOT run again on the next tick

#### Scenario: Recurring schedule advances before dispatch

- **WHEN** a recurring schedule is successfully claimed for dispatch
- **THEN** its `nextRunAt` SHALL advance by its interval before the prompt runs
- **AND** a later tick SHALL not dispatch the same occurrence again

#### Scenario: Stale runner guard aborts scheduled turn

- **GIVEN** a scheduled prompt is enqueued for a session via the shared turn dispatcher
- **AND** the runner for that session is replaced (e.g. by `/new` or `/resume`) before the queued turn starts
- **WHEN** the queued turn begins
- **THEN** the dispatcher SHALL detect the stale runner and abort before producing user-visible side effects
- **AND** SHALL NOT send the scheduled prompt to the old runner

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

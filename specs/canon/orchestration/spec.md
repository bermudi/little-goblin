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

The system SHALL dispatch agent turns through a shared turn dispatcher so that long-running turns do not block unrelated Telegram updates. The dispatcher SHALL live in the orchestration layer and SHALL accept an injected buffer factory from the Telegram layer. Turn serialization, runner lifecycle, and the stale-runner guard SHALL be owned by the dispatcher; Telegram rendering SHALL be owned by the buffer factory the Telegram layer injects.

#### Scenario: Long-running turn does not block another session

- **WHEN** session A is running a long turn
- **AND** session B receives a Telegram update
- **THEN** session B's update SHALL be processed without waiting for session A's turn to complete
- **AND** the dispatcher SHALL serialize turns per-session, not globally

#### Scenario: Dispatcher is transport-agnostic

- **WHEN** the dispatcher serializes a turn
- **THEN** it SHALL NOT depend on a Telegram-specific module
- **AND** both the live-transport (Telegram intake) and the scheduled-transport (scheduler) SHALL dispatch through the same dispatcher interface

### Requirement: Scheduler dispatches due turns through the per-session queue

The system SHALL run a single-process scheduler loop after session manager initialization and before or alongside Telegram long-polling. The scheduler SHALL poll the schedule store for due enabled schedules at a 60-second default interval, claim each due schedule one at a time within a tick before dispatch, and enqueue the scheduled prompt as a fresh turn through the same per-session queue used by `/queue` and media prompts.

The scheduler loop SHALL depend on sessions through a `SchedulerSessionSource` seam — a narrow interface exposing only `peekBinding(locator)` and `isArchived(sessionId)` — and SHALL NOT depend on the concrete `SessionManager` type. Production SHALL wire `SessionManager` as the adapter (it satisfies the seam structurally). Tests MAY inject a fake session source that returns canned bindings and archival states without instantiating a filesystem-backed session tree. This completes the scheduler's adapter set alongside the existing `SchedulerDispatcher` seam; the loop is then fakeable on all its external dependencies (clock, dispatcher, session source).

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
- **AND** SHALL NOT run again on the next tick

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

#### Scenario: Scheduler depends on the session source seam, not the concrete manager

- **WHEN** the scheduler loop validates a captured binding
- **THEN** it SHALL call `peekBinding` and `isArchived` through the `SchedulerSessionSource` interface
- **AND** SHALL NOT reference the concrete `SessionManager` type

#### Scenario: SessionManager satisfies the session source seam structurally

- **WHEN** the production composition root constructs the scheduler
- **THEN** it SHALL pass the real `SessionManager` as the `SchedulerSessionSource`
- **AND** no adapter wrapper SHALL be required (`SessionManager` already implements both methods)

#### Scenario: Eligibility tests inject a fake session source

- **WHEN** a scheduler test exercises due-turn eligibility for a session that is bound, archived, or mismatched
- **THEN** the test SHALL inject a fake `SchedulerSessionSource` returning the canned binding/archival state
- **AND** SHALL NOT create a real `SessionManager`, call `manager.init()`, or touch the filesystem for session state

#### Scenario: Archived schedule detected via the seam

- **WHEN** the scheduler ticks a schedule whose captured session directory no longer exists
- **THEN** the session source's `isArchived(sessionId)` SHALL return true
- **AND** the scheduler SHALL disable the schedule with an archived last-run status

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

The system SHALL locate turn serialization (the `TurnDispatcher`) in the orchestration layer, not in the Telegram layer. The dispatcher's job is runner lifecycle, per-session prompt queues, and the stale-runner guard — none of which is Telegram rendering. The dispatcher SHALL NOT reference the `MessageBuffer` type; the buffer (or a factory that produces one) SHALL be injected at dispatcher construction by the composition root, and the dispatcher SHALL treat it as an opaque turn sink.

Because the scheduler dispatches scheduled turns via `enqueueScheduledTurn` without passing a buffer, the dispatcher SHALL obtain the buffer through its injected factory when it needs one (e.g. inside `enqueueScheduledTurn`). The factory is wired once at construction by `src/index.ts`; the dispatcher itself SHALL NOT import from `src/tg/`.

The scheduler (`SchedulerLoop`) SHALL import the dispatcher from the orchestration layer and SHALL NOT import any module under `src/tg/`. The seam between the scheduler and the dispatcher is "turn → agent", not "turn → agent + Telegram rendering".

The Telegram layer (`src/tg/intake.ts`) SHALL be the only module that constructs `MessageBuffer` instances; it injects the factory into the dispatcher at the composition root.

#### Scenario: Scheduler does not import from the Telegram layer

- **WHEN** the scheduler module is compiled
- **THEN** it SHALL NOT import any module under `src/tg/`
- **AND** the dispatcher it depends on SHALL live under `src/orchestration/`

#### Scenario: Dispatcher does not reference the MessageBuffer type

- **WHEN** the dispatcher module is compiled
- **THEN** it SHALL NOT import `MessageBuffer` from `src/tg/mod.ts`
- **AND** the factory it holds SHALL be typed against an opaque sink interface, not against `MessageBuffer`

#### Scenario: Dispatcher obtains the buffer through its injected factory

- **WHEN** the dispatcher enqueues a scheduled turn (which requires a buffer to render the turn)
- **THEN** it SHALL obtain the buffer by calling the factory injected at construction
- **AND** SHALL NOT call `new MessageBuffer(...)` directly

#### Scenario: Telegram intake injects the buffer factory

- **WHEN** the composition root constructs the dispatcher
- **THEN** Telegram intake SHALL pass a `createMessageBuffer` factory that constructs `MessageBuffer` for a given locator
- **AND** the dispatcher SHALL hold that factory as an opaque value

### Requirement: Turn dispatcher runners map is encapsulated

The system SHALL encapsulate the dispatcher's runner map. The `runners` field SHALL be private; external modules SHALL NOT read `dispatcher.runners` directly. The dispatcher SHALL expose behavior-oriented methods for the queries intake currently performs by reading the map — at minimum, a method to fetch the current runner for a session id (returning `null` when none exists) and a method to test whether a runner exists for a session.

The stale-runner guard (`isCurrent()` / runner replacement detection) SHALL continue to work through the dispatcher's own methods; the encapsulation SHALL NOT weaken the guard.

#### Scenario: Intake gets the current runner via a method

- **WHEN** Telegram intake needs the current runner for a session (for stale-runner checks or deferred-command queueing)
- **THEN** it SHALL call a dispatcher method (e.g. `getRunner(sessionId)`)
- **AND** SHALL NOT read `dispatcher.runners.get(...)` directly

#### Scenario: No runner for a session returns null

- **WHEN** `getRunner(sessionId)` is called for a session with no current runner
- **THEN** it SHALL return `null`
- **AND** SHALL NOT throw

#### Scenario: Stale-runner guard remains after encapsulation

- **WHEN** a runner is replaced (by `/new` or `/resume`) before a queued turn starts
- **THEN** the dispatcher's stale-runner detection SHALL still abort the queued turn before side effects
- **AND** the guard SHALL be implemented via the dispatcher's own methods, not via external map reads

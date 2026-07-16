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

### Requirement: Agent self-scheduling tool has parity with /schedule

The system SHALL provide a `schedule_turn` tool, built in `src/scheduler/tool.ts` and registered in `AgentRunner.init()` for the main agent only. The tool SHALL NOT be registered for subagents. The tool SHALL support the following actions, backed by the existing `ScheduleStore` methods and the existing bounded time grammar (`parseDuration`, `parseAt`, `parseIn` from `src/scheduler/time.ts`):

- `create_once` — create a one-shot schedule. Exactly one of `in` (duration `30m`/`2h`/`1d`) or `at` (ISO-8601) SHALL be provided; providing both or neither SHALL fail the call with a schema error.
- `create_recurring` — create a recurring schedule using an `every` (duration) form and a `prompt` string.
- `list` — return this session's schedules (see *Agent tool list redacts user-owned prompts*).
- `remove` / `pause` / `resume` — mutate a schedule by id (see *Agent tool authority is scoped to agent-owned schedules*).
- `heartbeat` — `on [duration]`, `off`, or `status` (see *Agent tool authority is scoped to agent-owned schedules*).

The tool SHALL address schedules for its own session only, using the `sessionId` and `ChatLocator` of the `AgentRunner` it is bound to. `now` SHALL be taken from an injected clock provider passed to the tool factory (not `Date.now()` called directly), so tests are deterministic — mirroring how the `/schedule` command path receives `deps.now`. Duration and `at` validation SHALL reuse the exact `parseDuration` / `parseAt` / `parseIn` functions used by `/schedule`; no new time grammar is introduced.

Every schedule created via the tool SHALL be persisted to the same `ScheduleStore` used by `/schedule` and dispatched through the same scheduler loop and per-session turn queue, so an agent-originated scheduled turn is indistinguishable from a user-originated one at dispatch. Schedules created via the tool SHALL stamp `source: "agent"`. The tool SHALL return a machine-readable result shape including the affected schedule's `id`, `source`, and `nextRunAt` (ISO-8601), so the agent can reference it in later calls.

#### Scenario: Agent creates a one-shot schedule

- **WHEN** the agent calls `schedule_turn` with action `create_once`, `in: "30m"`, and a prompt
- **THEN** a schedule with `kind = "once"`, `source = "agent"`, and the session's id and locator SHALL be persisted
- **AND** the tool SHALL return the schedule's id and a `nextRunAt` ISO-8601 timestamp ~30 minutes in the future

#### Scenario: create_once with both in and at fails

- **WHEN** the agent calls `schedule_turn` with `create_once` and both `in` and `at`
- **THEN** the call SHALL fail with a schema error
- **AND** no schedule SHALL be created

#### Scenario: create_once with neither in nor at fails

- **WHEN** the agent calls `schedule_turn` with `create_once` and neither `in` nor `at`
- **THEN** the call SHALL fail with a schema error
- **AND** no schedule SHALL be created

#### Scenario: Invalid duration rejected by shared parser

- **WHEN** the agent calls `schedule_turn` with `create_recurring` and `every: "7w"`
- **THEN** the call SHALL fail because `parseDuration` rejects the token
- **AND** no schedule SHALL be created

#### Scenario: Agent-managed schedule dispatches as a fresh turn

- **GIVEN** an agent-created schedule whose `nextRunAt` is in the past and whose session remains bound
- **WHEN** the scheduler ticks
- **THEN** the schedule's prompt SHALL be enqueued as a fresh turn through the per-session queue
- **AND** SHALL serialize behind any in-flight turn identically to a user-originated schedule

#### Scenario: Tool is main-agent only

- **WHEN** a subagent session is initialized (`src/subagents/execution.ts`)
- **THEN** the `schedule_turn` tool SHALL NOT be present in that subagent's toolset

#### Scenario: Tool absent when scheduleStore not wired

- **WHEN** an `AgentRunner` is constructed without a `scheduleStore`
- **THEN** the `schedule_turn` tool SHALL NOT be registered
- **AND** the runner SHALL function normally otherwise

### Requirement: Agent tool authority is scoped to agent-owned schedules

The agent tool's mutating actions (`remove`, `pause`, `resume`) and heartbeat mutation SHALL operate only on schedules whose `source` is `"agent"`. The tool SHALL NOT remove, pause, resume, disable, or overwrite a schedule whose `source` is `"user"` (or absent, which reads as `"user"`). Heartbeat mutation from the agent tool SHALL NOT turn off or overwrite a heartbeat that is currently user-owned; if the existing heartbeat's `source` is `"user"` and the agent requests `heartbeat off` or `heartbeat on`, the call SHALL fail with an authority error and SHALL NOT modify the store.

The `/schedule` human command path SHALL retain authority over all schedules regardless of `source`: it may create, list, remove, pause, resume, and manage heartbeats for both user- and agent-owned schedules.

This holds regardless of session: even within the same session, an agent turn cannot touch the user's schedules. Authority is enforced by `source`, and session ownership (already enforced by `ScheduleStore`) is a separate, additional check.

#### Scenario: Agent removes its own schedule

- **GIVEN** a schedule owned by the session with `source = "agent"`
- **WHEN** the agent calls `schedule_turn` with action `remove` and that schedule's id
- **THEN** the schedule SHALL be removed from the store

#### Scenario: Agent cannot remove a user schedule

- **GIVEN** a schedule owned by the session with `source = "user"`
- **WHEN** the agent calls `schedule_turn` with action `remove` and that schedule's id
- **THEN** the call SHALL fail with an authority error
- **AND** the store SHALL be unchanged

#### Scenario: Agent cannot pause a user schedule

- **GIVEN** a schedule owned by the session with `source = "user"`
- **WHEN** the agent calls `schedule_turn` with action `pause` and that schedule's id
- **THEN** the call SHALL fail with an authority error
- **AND** the schedule SHALL remain enabled

#### Scenario: Agent cannot turn off a user-owned heartbeat

- **GIVEN** a session with an enabled heartbeat whose `source = "user"`
- **WHEN** the agent calls `schedule_turn` with action `heartbeat` and `off`
- **THEN** the call SHALL fail with an authority error
- **AND** the heartbeat SHALL remain enabled

#### Scenario: User command manages agent schedules

- **GIVEN** a schedule owned by the session with `source = "agent"`
- **WHEN** the user runs `/schedule remove <id>`
- **THEN** the schedule SHALL be removed (the human command has authority over all sources)

### Requirement: Agent tool list redacts user-owned prompts

The agent tool's `list` action SHALL NOT return the `prompt` body of any schedule whose `source` is `"user"` into model context. User-owned schedules SHALL appear as redacted metadata only — at minimum `id`, `kind`, `state`, `nextRunAt`, and a marker indicating the schedule is user-owned and not agent-manageable — with the `prompt` field omitted or set to a sentinel such as `"<user-owned: not shown>"`. Agent-owned schedules SHALL be returned in full, including their `prompt`. This prevents prompt text the user authored (which may contain private or sensitive content) from being surfaced into an autonomous turn's context.

#### Scenario: List omits user prompt bodies

- **GIVEN** a session owns a user-created schedule with a prompt body and an agent-created schedule with a prompt body
- **WHEN** the agent calls `schedule_turn` with action `list`
- **THEN** the agent-created schedule SHALL include its full prompt
- **AND** the user-created schedule SHALL NOT include its prompt body
- **AND** the user-created schedule SHALL appear with id, kind, state, nextRunAt, and a user-owned marker

### Requirement: Agent-originated schedules are bounded by a per-session cap

The system SHALL enforce a per-session cap on enabled agent-source schedules, defined by the constant `MAX_AGENT_SCHEDULES` (default **8**). The invariant SHALL be: after any `ScheduleStore` mutation triggered via the agent tool, the count of records owned by that session with `source === "agent"` and `state === "enabled"` SHALL NOT exceed `MAX_AGENT_SCHEDULES`. User-originated schedules and disabled/completed schedules SHALL NOT count toward the cap.

The cap SHALL be enforced at the store mutation boundary for every transition into the `enabled` state originating from the agent tool, specifically: `create_once`, `create_recurring`, `resume` (disabled→enabled), and `heartbeat on`. When such a mutation would exceed the cap, the mutation SHALL be refused and the store SHALL be unchanged, and the agent tool SHALL receive a cap-exceeded error reporting the cap and directing it to remove or pause an existing schedule first.

The cap SHALL NOT apply to schedules created or resumed via the `/schedule` command path, regardless of count. Enforcing at the store mutation boundary (rather than a tool-level count→create sequence) keeps the invariant atomic: the full record list is known at the point of mutation, so there is no count/create race window.

#### Scenario: Create under cap succeeds

- **GIVEN** a session with 3 enabled agent-source schedules
- **WHEN** the agent creates a fourth via `schedule_turn`
- **THEN** the schedule SHALL be created and persisted

#### Scenario: Create at cap fails

- **GIVEN** a session with `MAX_AGENT_SCHEDULES` enabled agent-source schedules
- **WHEN** the agent calls `schedule_turn` to create another
- **THEN** the mutation SHALL be refused with a cap-exceeded error
- **AND** the store SHALL be unchanged

#### Scenario: Resume at cap fails

- **GIVEN** a session at the cap where one agent-source schedule is disabled (so the cap is met by other enabled agent schedules)
- **WHEN** the agent calls `schedule_turn` to `resume` the disabled schedule (disabled→enabled)
- **THEN** the mutation SHALL be refused with a cap-exceeded error
- **AND** the schedule SHALL remain disabled

#### Scenario: Pausing frees cap headroom

- **GIVEN** a session at the cap with an enabled agent-source schedule `X`
- **WHEN** the agent pauses `X` via `schedule_turn`
- **AND** then creates a new schedule
- **THEN** the new schedule SHALL be created, because paused schedules do not count

#### Scenario: User schedules are not capped

- **GIVEN** a session already at `MAX_AGENT_SCHEDULES` enabled agent-source schedules
- **WHEN** the user runs `/schedule every 1h <prompt>`
- **THEN** the user's schedule SHALL be created regardless of the agent cap

### Requirement: Schedule records carry provenance

Each `ScheduledTurn` SHALL carry an optional `source` field of type `"user" | "agent"`. The `/schedule` command path SHALL stamp `source: "user"`; the `schedule_turn` agent tool SHALL stamp `source: "agent"`. When `source` is absent (e.g. a record created before this change), it SHALL be treated as `"user"` for the purposes of cap counting, authority checks, list redaction, and display. The `/schedule list` command SHALL annotate agent-originated schedules with an `[agent]` tag so the user can see, in Telegram, which schedules the goblin created itself.

Any `/schedule`-path mutation of an existing record (`pause`, `resume`, `heartbeat on`, `heartbeat off`) SHALL re-stamp `source` to `"user"`. This "last writer owns" principle ensures that once the user touches a schedule, the agent cannot subsequently undo the user's action: the agent cannot re-enable a heartbeat the user disabled, resume a schedule the user paused, or disable a heartbeat the user re-enabled. The agent path SHALL NOT re-stamp `source` (it can only touch agent-owned records, so re-stamping would be a no-op). The only way for the agent to regain control of a user-claimed schedule is for the user to `remove` it so the agent can create a fresh one.

Provenance is structural and SHALL be retained even if the cap policy is later relaxed: it drives authority (see *Agent tool authority is scoped to agent-owned schedules*), list redaction, display annotation, and audit/debugging.

#### Scenario: User schedule stamped user

- **WHEN** the user creates a schedule via `/schedule`
- **THEN** the persisted record SHALL have `source = "user"`

#### Scenario: Agent schedule stamped agent

- **WHEN** the agent creates a schedule via `schedule_turn`
- **THEN** the persisted record SHALL have `source = "agent"`

#### Scenario: Legacy record treated as user

- **GIVEN** a schedule record on disk with no `source` field (created before this change)
- **WHEN** it is loaded
- **THEN** it SHALL be treated as `source = "user"` for cap counting, authority checks, list redaction, and display

#### Scenario: List annotates agent schedules

- **WHEN** the user runs `/schedule list`
- **AND** the session owns both user- and agent-originated schedules
- **THEN** agent-originated rows SHALL be annotated with `[agent]`
- **AND** user-originated rows SHALL carry no such tag

#### Scenario: User re-enabling an agent heartbeat claims ownership

- **GIVEN** a session with a heartbeat whose `source = "agent"` and `state = "disabled"`
- **WHEN** the user runs `/schedule heartbeat on`
- **THEN** the persisted record SHALL have `source = "user"`
- **AND** the agent SHALL NOT be able to disable it via `schedule_turn heartbeat off`

#### Scenario: User disabling an agent heartbeat claims ownership

- **GIVEN** a session with an enabled heartbeat whose `source = "agent"`
- **WHEN** the user runs `/schedule heartbeat off`
- **THEN** the persisted record SHALL have `source = "user"`
- **AND** the agent SHALL NOT be able to re-enable it via `schedule_turn heartbeat on`

#### Scenario: User pausing an agent schedule claims ownership

- **GIVEN** a session with an enabled schedule whose `source = "agent"`
- **WHEN** the user runs `/schedule pause <id>`
- **THEN** the persisted record SHALL have `source = "user"`
- **AND** the agent SHALL NOT be able to resume it via `schedule_turn resume`

### Requirement: Disposing a session runner cancels its subagents

When `TurnDispatcher.disposeRunner(sessionId)` is called, the dispatcher SHALL
first dispose the `AgentRunner` for the session, remove it from the runner cache,
and clear the session's prompt queue. It SHALL then call
`SubagentRunner.cancelBySession(sessionId)` to cancel all subagents spawned by
that session, and SHALL await the cascade. `disposeRunner` SHALL be
async (`Promise<void>`) so callers can await the full cleanup.

`cancelPending(sessionId)` SHALL NOT cascade to subagents. It aborts a queued
prompt but the session remains alive — its subagents may still be doing useful
work. A code-level comment or JSDoc on `cancelPending` SHALL document this
non-cascading behavior so future maintainers do not add it by mistake.

#### Scenario: disposeRunner disposes the runner before canceling subagents

- **WHEN** `disposeRunner("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `running`
- **THEN** the runner for "session-abc" SHALL be disposed and removed from the
  cache first
- **AND** A SHALL be cancelled via `cancelBySession` after the runner is disposed

#### Scenario: disposeRunner with no subagents is a no-op for the cascade

- **WHEN** `disposeRunner("session-xyz")` is called
- **AND** no active subagent has `spawnedBy === "session-xyz"`
- **THEN** `cancelBySession` SHALL return without error
- **AND** the runner SHALL be disposed normally

#### Scenario: cancelPending does not cascade

- **WHEN** `cancelPending("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `running`
- **THEN** A SHALL NOT be cancelled
- **AND** A SHALL continue running
- **AND** only the queued prompt for "session-abc" SHALL be aborted

#### Scenario: `applySideEffects` is async and awaits `disposeRunner`

- **WHEN** `applySideEffects` processes a `runner-disposed` side effect
- **THEN** `applySideEffects` SHALL be declared `async` and return
  `Promise<void>`
- **AND** `applySideEffects` SHALL `await` `disposeRunner(effect.sessionId)`
- **AND** the `handleText` call sites that invoke `applySideEffects` SHALL also
  `await` it

#### Scenario: disposeRunner is awaited before the next side effect

- **WHEN** a command returns a `runner-disposed` side effect
- **THEN** intake SHALL await `disposeRunner` before processing the next side
  effect
- **AND** if the next side effect is `runner-created` (e.g. `/new`, `/resume`),
  the new runner SHALL be created only after the old session's subagents are
  cancelled

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

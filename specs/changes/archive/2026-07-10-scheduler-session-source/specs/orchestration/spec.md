# orchestration

## MODIFIED Requirements

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

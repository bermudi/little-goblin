# orchestration

## ADDED Requirements

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

## MODIFIED Requirements

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

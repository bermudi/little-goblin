# orchestration

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Agent turns do not block unrelated updates

The system SHALL dispatch agent turns through the shared turn dispatcher without blocking unrelated Telegram updates. Serialization, runtime lifecycle, and stale-runtime guards SHALL be per conversation; rendering remains supplied by the surface adapter.

#### Scenario: Long turn does not block another conversation

- **WHEN** conversation A runs a long turn
- **AND** conversation B receives an update
- **THEN** B SHALL be processed without waiting for A

#### Scenario: Same conversation serializes

- **WHEN** two fresh turns target the same current conversation runtime
- **THEN** they SHALL serialize through that conversation's queue

### Requirement: Turn serialization lives in the orchestration layer

The `TurnDispatcher` SHALL continue to own conversation runtime creation, per-conversation prompt queues, and stale-runtime checks without importing Telegram modules. A surface adapter SHALL inject opaque sink and Telegram-tool factories, and the dispatcher SHALL receive a narrow read interface for current binding, surface settings, and conversation environment rather than the broad lifecycle implementation.

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

### Requirement: Schedule records carry provenance

Each surface-owned schedule SHALL retain optional `source: "user" | "agent"` provenance, with absent values treated as user-owned. Existing last-writer authority, user display annotation, and prompt-redaction behavior SHALL remain, independent of which conversation is currently bound.

#### Scenario: User claims an agent schedule after rotation

- **GIVEN** a surface owns an agent schedule and later rotates conversations
- **WHEN** the user mutates that schedule through `/schedule`
- **THEN** its source SHALL become `user`
- **AND** the current agent runtime SHALL not regain mutation authority

## REMOVED Requirements

### Requirement: Scheduler dispatches due turns through the per-session queue

### Requirement: Agent-originated schedules are bounded by a per-session cap

### Requirement: Disposing a session runner cancels its subagents

# orchestration

## ADDED Requirements

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

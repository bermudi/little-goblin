# sessions

## ADDED Requirements

### Requirement: Use distinct lifecycle terms

Goblin SHALL use **surface** for a stable Telegram delivery lane, **binding** for the current surface-to-conversation association, **conversation** for durable user-visible history, and **conversation runtime** for the in-memory runner and prompt queue serving a bound conversation. The term “session” SHALL remain only where it names pi's `AgentSession`, a compatibility symbol, or the legacy `state/sessions/` filesystem path.

#### Scenario: Durable history is described

- **WHEN** code, logs, diagnostics, or user-facing text refers to Goblin's persisted transcript and metadata
- **THEN** it SHALL call that object a conversation
- **AND** SHALL NOT call the Telegram surface or runtime a session

### Requirement: Conversation lifecycle is a deep module

The system SHALL expose one conversation-lifecycle interface that owns complete inspect, resolve-or-start, rotate, resume, and archive operations. Callers SHALL NOT coordinate direct binding-file edits, conversation-record edits, and runtime disposal as separate lifecycle steps.

#### Scenario: Caller rotates a surface

- **WHEN** a caller requests rotation for a surface
- **THEN** the lifecycle module SHALL quiesce the prior runtime, create a fresh conversation in the surface's effective execution environment, update the binding, and return the resulting conversation
- **AND** the caller SHALL NOT perform any of those persistence steps itself

#### Scenario: Caller inspects without mutation

- **WHEN** a caller inspects an unbound surface
- **THEN** the lifecycle module SHALL report that no conversation is bound
- **AND** SHALL NOT create a conversation or mutate persistence

### Requirement: Authorized ordinary messages resolve or start conversations

The lifecycle module SHALL resolve the bound conversation for an authorized ordinary Telegram message and SHALL lazily create and bind a conversation when the message's surface is unbound. This behavior SHALL apply uniformly to every supported ordinary surface, including DMs. Slash commands other than explicit conversation-creation commands, scheduler ticks, internal jobs, and proactive delivery MUST use non-creating inspection.

#### Scenario: First ordinary DM message

- **WHEN** an authorized user sends ordinary content on an unbound DM surface
- **THEN** the system SHALL create a conversation using the surface's effective execution environment
- **AND** SHALL bind it before dispatching the content

#### Scenario: First ordinary topic message

- **WHEN** an authorized user sends ordinary content on an unbound topic surface
- **THEN** the same resolve-or-start operation SHALL create and bind a conversation

#### Scenario: Internal resolution does not create

- **WHEN** a scheduler tick, internal job, proactive delivery attempt, or status command inspects an unbound surface
- **THEN** no conversation SHALL be created

### Requirement: A conversation has at most one active binding

A non-archived conversation SHALL be actively bound to at most one surface. Resuming a conversation that is bound elsewhere SHALL atomically remove its prior binding and bind it to the destination; a conversation displaced from the destination SHALL remain stored, unarchived, and resumable.

#### Scenario: Resume moves a bound conversation

- **GIVEN** conversation A is bound to surface X
- **AND** conversation B is bound to surface Y
- **WHEN** A is resumed on Y
- **THEN** one atomic binding-file replacement SHALL leave A bound only to Y
- **AND** X SHALL be unbound
- **AND** B SHALL remain stored as an unbound resumable conversation

#### Scenario: Resume an already-current conversation

- **WHEN** the destination surface is already bound to the requested conversation
- **THEN** the lifecycle operation SHALL be idempotent
- **AND** SHALL NOT create, archive, or duplicate a binding

### Requirement: Resume requires execution-environment compatibility

The lifecycle module SHALL permit a conversation to bind to a destination surface only when the conversation's immutable execution environment equals the surface's effective execution environment. An incompatible attempt MUST fail before runtime disposal or binding mutation.

#### Scenario: Incompatible resume is rejected

- **GIVEN** a personal conversation and a project surface
- **WHEN** the user attempts to resume the personal conversation on the project surface
- **THEN** the operation SHALL report the environment mismatch
- **AND** all existing bindings and runtimes SHALL remain unchanged

#### Scenario: Matching project environment resumes

- **GIVEN** a conversation and destination surface that identify the same canonical project environment
- **WHEN** the conversation is resumed on the destination
- **THEN** the lifecycle module SHALL allow the move

### Requirement: Surface and conversation state have separate owners

Model and thinking preferences, schedules, heartbeat enablement/interval, and the surface-specific heartbeat prompt SHALL be owned by `SurfaceId`. Conversation ID, name, creation time, transcript, events, metrics, pi history, and immutable execution environment SHALL be owned by the conversation. Rotating or resuming a conversation MUST NOT copy, clear, disable, or duplicate surface-owned state.

#### Scenario: Rotate preserves surface state

- **GIVEN** a surface has model and thinking preferences plus enabled schedules and heartbeat configuration
- **WHEN** the surface rotates to a fresh conversation
- **THEN** all of those surface-owned values SHALL remain attached to the same `SurfaceId`
- **AND** the fresh conversation SHALL retain only its own conversation state

#### Scenario: Resume adopts destination preferences

- **GIVEN** a conversation moves from surface X to compatible surface Y
- **WHEN** its destination runtime is next created
- **THEN** the runtime SHALL use Y's model, thinking, automation, memory scope, tools, and delivery settings
- **AND** SHALL NOT carry X's surface-owned settings with it

### Requirement: Generate short conversation IDs

The lifecycle module SHALL generate 10-character lowercase hexadecimal conversation IDs from UUID v4, preserving the existing collision characteristics and filesystem-safe format.

#### Scenario: New conversation ID

- **WHEN** the lifecycle module creates a conversation
- **THEN** its ID SHALL contain exactly 10 lowercase hexadecimal characters

### Requirement: Persist surface heartbeat prompts

A surface-specific heartbeat prompt SHALL live at `$GOBLIN_HOME/state/surfaces/<SurfaceId>/HEARTBEAT.md`, resolved only through a path helper that first validates and canonicalizes the SurfaceId. The file belongs to the Surface and SHALL survive conversation rotation, movement, archive, and temporary unbinding. Reads SHALL return `null` only for `ENOENT`; other errors MUST propagate.

#### Scenario: Heartbeat prompt survives new

- **GIVEN** a Surface has a custom heartbeat prompt
- **WHEN** `/new` rotates its Conversation
- **THEN** the same Surface path SHALL supply the next heartbeat prompt

#### Scenario: Invalid SurfaceId is rejected

- **WHEN** the path helper receives an invalid, non-canonical, or traversal-bearing SurfaceId
- **THEN** it SHALL throw without returning a path outside `$GOBLIN_HOME/state/surfaces/`

### Requirement: Persist conversation records atomically in the legacy layout

Conversation state SHALL continue to live under `state/sessions/<conversationId>/` and SHALL be written atomically through the JSON state-file module. The stored conversation record MUST NOT use creation-time Telegram chat or topic fields as current routing state.

#### Scenario: Conversation record is saved

- **WHEN** conversation metadata is updated
- **THEN** `state/sessions/<conversationId>/state.json` SHALL be replaced atomically
- **AND** current routing SHALL be discoverable from bindings rather than `chatId` or `topicId` in that record

### Requirement: Create conversation filesystem layout

Creating a conversation SHALL create `state/sessions/<conversationId>/`, its pi-history and existing JSONL artifacts, and `state.json` without renaming the legacy directory tree.

#### Scenario: Conversation is created

- **WHEN** the lifecycle module starts a conversation
- **THEN** the existing transcript, events, metrics, pi-history, and state paths SHALL be initialized for that conversation ID

### Requirement: List resumable conversations by environment

The lifecycle module SHALL list non-archived conversations, including unbound conversations, sorted by creation time. A destination-aware listing SHALL include only conversations compatible with that surface's effective execution environment; internal conversations and `state/sessions/archive/` SHALL be excluded.

#### Scenario: Destination-aware list

- **WHEN** resumable conversations are listed for a project surface
- **THEN** only conversations with the same canonical project execution environment SHALL be returned
- **AND** unbound compatible conversations SHALL be included

#### Scenario: Missing conversation directory

- **WHEN** the legacy `state/sessions/` directory is absent
- **THEN** listing SHALL return an empty array without throwing

### Requirement: Persist surface conversation preferences

The system SHALL persist optional model and thinking preferences in the surface-settings record keyed by canonical `SurfaceId`, using the dependency-provided atomic surface-settings storage. Updating either preference SHALL affect the current and future conversations on that surface without rewriting conversation state.

#### Scenario: Model preference survives rotation

- **WHEN** a surface's model preference is set and the conversation rotates
- **THEN** the surface-settings record SHALL retain the preference
- **AND** the next runtime on that surface SHALL use it

### Requirement: Migrate legacy lifecycle state idempotently

Startup SHALL idempotently migrate legacy conversation records, bindings, model/thinking preferences, schedules, heartbeat records, and surface heartbeat prompt files to the split ownership model without deleting conversation history. Migration SHALL repair conversations referenced by multiple surface bindings to the one-active-binding invariant, preserve every displaced conversation as resumable, and log each repair with the conversation ID and affected surface IDs. Expected missing files may be skipped; invalid data and non-`ENOENT` filesystem errors MUST fail loudly.

#### Scenario: Legacy conversation has several bindings

- **GIVEN** one legacy conversation is referenced by several migrated surface bindings
- **WHEN** migration runs
- **THEN** it SHALL retain one deterministic active binding and clear the others in one binding-file replacement
- **AND** SHALL log the retained and cleared surface IDs
- **AND** SHALL leave the conversation directory intact

#### Scenario: Migration restarts after partial completion

- **WHEN** startup reruns migration after some target files were already written
- **THEN** migration SHALL converge on the same state without duplicating schedules, losing settings, or deleting history

## MODIFIED Requirements

### Requirement: Resolve sessions from complete Surface values

The compatibility session manager and the conversation lifecycle SHALL accept complete Surface values. Non-creating inspection SHALL return the current bound conversation or `null`. The authorized ordinary-message path SHALL use `resolveOrStart(surface)` and lazily create a conversation for every supported unbound ordinary Surface, including DMs. Commands, scheduler ticks, internal jobs, and proactive delivery MUST use inspection and MUST NOT trigger creation.

#### Scenario: Authorized DM content starts history

- **WHEN** authorized ordinary content arrives on an unbound DM Surface
- **THEN** `resolveOrStart()` SHALL create and bind a compatible conversation

#### Scenario: Inspection is non-creating

- **WHEN** a command or scheduler inspects an unbound auto-creating Surface
- **THEN** it SHALL receive `null`
- **AND** no files or bindings SHALL be written

### Requirement: Surface-based creation and rebinding preserve conversation identity

Conversation creation SHALL capture the Surface's effective execution environment. Resuming an existing conversation SHALL go through the lifecycle module, require environment compatibility, clear every previous binding for the target, displace but preserve the destination's prior conversation, and commit the move with one atomic binding write. The old public operation that can add another binding without clearing the first MUST NOT remain available to callers.

#### Scenario: Compatible resume moves instead of shares

- **GIVEN** conversation A is bound to Surface X
- **WHEN** A is resumed on compatible Surface Y
- **THEN** the resulting binding map SHALL bind A only to Y
- **AND** X SHALL be unbound

#### Scenario: Incompatible resume is unchanged

- **WHEN** a conversation and destination Surface have different environments
- **THEN** no binding SHALL change

### Requirement: Persist bindings atomically

The system SHALL persist one canonical `SurfaceId -> conversationId` binding map using atomic replacement. Binding mutation helpers SHALL preserve the one-active-binding-per-conversation invariant and SHALL never infer surface kind from numeric identifiers.

#### Scenario: Binding move is saved

- **WHEN** a conversation moves between surfaces
- **THEN** removal of the old binding, displacement at the destination, and creation of the new binding SHALL be represented by one atomic write

### Requirement: Persist scheduled turn definitions

The system SHALL persist scheduled turn definitions outside conversation directories using atomic writes. Each record SHALL be owned by a canonical surface and contain its id, surface identity, kind, state, next run timestamp, recurrence and provenance metadata, plus prompt text where applicable; it MUST NOT capture a conversation ID as its durable owner. Heartbeat records SHALL store no prompt body because the surface-specific/global fallback is resolved at dispatch time.

#### Scenario: Schedule is created

- **WHEN** a user or agent creates a schedule from a bound surface
- **THEN** the record SHALL contain that `SurfaceId`
- **AND** SHALL NOT contain the current conversation ID as its owner

### Requirement: Scheduled turns stay bound to their captured session surface

A scheduled occurrence SHALL address its captured surface and resolve that surface's current binding non-mutatively at dispatch time. If the surface is unbound, the occurrence SHALL remain pending and enabled, SHALL NOT create a conversation, and SHALL be eligible on a later tick. If a conversation is bound, the scheduler SHALL dispatch through that conversation's current runtime without comparing against a creation-time conversation ID.

#### Scenario: Surface has a current conversation

- **WHEN** a schedule is due and its surface has a bound compatible conversation
- **THEN** the scheduler SHALL dispatch the prompt as a fresh turn through that conversation runtime

#### Scenario: Surface is temporarily unbound

- **WHEN** a schedule is due and inspection reports no binding
- **THEN** the scheduler SHALL leave the occurrence due and enabled
- **AND** SHALL NOT create a conversation or disable the schedule

### Requirement: Heartbeat schedule is explicit and session-scoped

Heartbeat SHALL be an explicit, disabled-by-default, surface-owned schedule with a 30-minute default interval. Its prompt SHALL be resolved at dispatch time from the surface-specific heartbeat prompt, then `$GOBLIN_HOME/workspace/HEARTBEAT.md`, then the system constant; first non-whitespace content wins, trailing whitespace is stripped, leading whitespace is preserved, and the dispatched prompt begins with exactly one `[heartbeat]` marker. Non-`ENOENT` read errors MUST propagate and prevent that occurrence from dispatching. Rotating, resuming, archiving, or temporarily unbinding a conversation SHALL NOT disable or transfer the heartbeat.

#### Scenario: Heartbeat survives conversation rotation

- **GIVEN** heartbeat is enabled for a surface
- **WHEN** `/new` rotates that surface's conversation
- **THEN** the same heartbeat record and next-run state SHALL remain attached to the surface

#### Scenario: Unbound heartbeat remains pending

- **WHEN** heartbeat becomes due while its surface is unbound
- **THEN** no conversation SHALL be created
- **AND** the occurrence SHALL remain pending for the next bound conversation

#### Scenario: Prompt fallback uses surface configuration

- **WHEN** a due heartbeat's surface-specific prompt contains non-whitespace text
- **THEN** that text SHALL be used without consulting the global file
- **AND** the prompt SHALL begin with exactly one `[heartbeat]` marker

### Requirement: Topic settings file

The dependency-provided surface-settings store SHALL remain the atomic persistence module for per-surface execution assignment and pending notices, and SHALL additionally hold model and thinking preferences keyed by canonical `SurfaceId`. Missing or malformed JSON SHALL use the established default-and-warning policy; non-`ENOENT`, non-syntax errors MUST propagate.

#### Scenario: Surface settings load

- **WHEN** settings are read for a surface
- **THEN** project assignment, model preference, thinking preference, and pending notices SHALL resolve from the same canonical `SurfaceId` slot

## REMOVED Requirements

### Requirement: Generate short session IDs

### Requirement: Create session filesystem layout

### Requirement: List all sessions

### Requirement: Return empty array for missing sessions directory

### Requirement: List resumable sessions excludes archive

### Requirement: Persist session titles

### Requirement: Session-scoped heartbeat prompt file path

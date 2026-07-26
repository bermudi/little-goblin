# sessions

## ADDED Requirements

### Requirement: Use distinct lifecycle terms

Goblin SHALL use **surface** for a stable Telegram delivery lane, **binding** for the current surface-to-conversation association, **conversation** for durable user-visible history, and **conversation runtime** for the in-memory runner and prompt queue serving a bound conversation. The term “session” SHALL remain only where it names pi's `AgentSession`, a compatibility symbol, or the legacy `state/sessions/` filesystem path.

#### Scenario: Durable history is described

- **WHEN** code, logs, diagnostics, or user-facing text refers to Goblin's persisted transcript and metadata
- **THEN** it SHALL call that object a conversation
- **AND** SHALL NOT call the Telegram surface or runtime a session

### Requirement: Export canonical Conversation persistence types

`src/sessions/mod.ts` SHALL export `ConversationId`, `ConversationState`, and the Conversation persistence interfaces used by orchestration. `Surface` and `SurfaceId` SHALL remain exported by the pure shared Surface module. `SessionManager` and `SessionState` MAY remain only as deprecated compatibility exports while callers migrate; obsolete public partial-binding methods MUST NOT remain.

#### Scenario: New caller imports Conversation persistence

- **WHEN** a new domain caller needs Conversation identity or persistence
- **THEN** it SHALL import canonical Conversation types/interfaces rather than `SessionState` or `ChatLocator`
- **AND** routing identity SHALL come from the shared Surface module

#### Scenario: Compatibility facade remains bounded

- **WHEN** a legacy caller temporarily imports `SessionManager` or `SessionState`
- **THEN** the export SHALL be marked as compatibility-only
- **AND** SHALL expose no operation that can add a second active binding for a Conversation

### Requirement: Conversation lifecycle is a deep module

The system SHALL expose one conversation-lifecycle interface that owns complete inspect, resolve-or-start, rotate, resume, and archive operations. Every binding-changing operation SHALL use the dependency-provided process-wide lifecycle-transition lock so unbound creation and cross-Surface moves cannot race. Callers SHALL NOT coordinate direct binding-file edits, conversation-record edits, and runtime disposal as separate lifecycle steps.

#### Scenario: Caller rotates a surface

- **WHEN** a caller requests rotation for a surface
- **THEN** the lifecycle module SHALL quiesce the prior runtime, create a fresh conversation in the surface's effective execution environment, update the binding, and return the resulting conversation
- **AND** the caller SHALL NOT perform any of those persistence steps itself

#### Scenario: Rotate quiescence fails before creation

- **GIVEN** a Surface is bound to Conversation P
- **WHEN** rotate invalidates P's runtime but required cleanup fails
- **THEN** no fresh Conversation SHALL be created
- **AND** the Surface SHALL remain bound to P
- **AND** the invalidated runtime object SHALL NOT be restored or reused
- **AND** a later turn MAY construct a fresh runtime for still-bound P

#### Scenario: Concurrent binding transitions serialize

- **WHEN** two operations would create, rotate, assign, or move bindings concurrently
- **THEN** each SHALL re-read authority while holding the shared transition lock
- **AND** one complete operation SHALL commit or fail before the other mutates persistence

#### Scenario: Caller inspects without mutation

- **WHEN** a caller inspects an unbound surface
- **THEN** the lifecycle module SHALL report that no conversation is bound
- **AND** SHALL NOT create a conversation or mutate persistence

#### Scenario: Archive storage move fails after unbinding

- **GIVEN** a Surface is bound to a Conversation whose runtime has quiesced
- **WHEN** archive atomically clears the binding but moving the Conversation directory fails
- **THEN** the lifecycle operation SHALL fail loudly
- **AND** the Conversation SHALL remain unbound, unarchived, and resumable
- **AND** the invalidated runtime SHALL NOT be restored

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

Project assignment, model and thinking preferences, schedules, heartbeat enablement/interval, and the surface-specific heartbeat prompt SHALL be owned by `SurfaceId`. The current bound Surface SHALL be the sole routing input to the active memory-context projection; that projection is not a second persisted Surface setting and MUST NOT derive from Conversation creation metadata. Conversation ID, name, creation time, transcript, events, metrics, pi history, and immutable execution environment SHALL be owned by the Conversation. Rotating or resuming a Conversation MUST NOT copy, clear, disable, or duplicate Surface-owned state. Skill policy ownership is outside this change and remains defined by `surface-skill-policy`.

#### Scenario: Rotate preserves surface state

- **GIVEN** a Surface has project assignment, model and thinking preferences, enabled schedules, heartbeat configuration, and a memory context projected from its identity
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

Conversation state SHALL continue to live under `state/sessions/<conversationId>/` and SHALL be loaded and written through the JSON state-file module. Writes SHALL use atomic sibling-temp replacement; a missing `state.json` SHALL load as `null` so the Conversation is treated as missing. The stored conversation record MUST NOT use creation-time Telegram chat or topic fields as current routing state.

#### Scenario: Conversation record is saved

- **WHEN** conversation metadata is updated
- **THEN** `state/sessions/<conversationId>/state.json` SHALL be replaced atomically through the state-file module
- **AND** current routing SHALL be discoverable from bindings rather than `chatId` or `topicId` in that record

#### Scenario: Conversation record is missing

- **WHEN** the state-file module loads a Conversation whose `state.json` does not exist
- **THEN** it SHALL return `null`
- **AND** SHALL NOT manufacture default Conversation state

### Requirement: Create conversation filesystem layout

Creating a conversation SHALL create `state/sessions/<conversationId>/`, its pi-history and existing JSONL artifacts, and `state.json` without renaming the legacy directory tree.

#### Scenario: Conversation is created

- **WHEN** the lifecycle module starts a conversation
- **THEN** the existing transcript, events, metrics, pi-history, and state paths SHALL be initialized for that conversation ID

### Requirement: List resumable conversations by environment

The lifecycle module SHALL list non-archived conversations, including unbound conversations, sorted by creation time ascending (oldest first). A destination-aware listing SHALL include only conversations compatible with that surface's effective execution environment; internal conversations and `state/sessions/archive/` SHALL be excluded.

#### Scenario: Destination-aware list

- **WHEN** resumable conversations are listed for a project surface
- **THEN** only conversations with the same canonical project execution environment SHALL be returned
- **AND** unbound compatible conversations SHALL be included

#### Scenario: Missing conversation directory

- **WHEN** the legacy `state/sessions/` directory is absent
- **THEN** listing SHALL return an empty array without throwing

### Requirement: Persist Conversation names

The Conversation store SHALL set or clear an existing Conversation's optional name and persist the updated canonical record atomically. The legacy `title` field MAY remain as a compatibility storage name, but callers and user-visible behavior SHALL call it a Conversation name. Updating a missing Conversation MUST fail loudly.

#### Scenario: Conversation name is set

- **WHEN** the store sets Conversation `abc123def0`'s name to `memory refactor`
- **THEN** its canonical `state.json` SHALL persist that name atomically
- **AND** loading the Conversation SHALL return `memory refactor`

#### Scenario: Conversation name is cleared

- **WHEN** the store clears an existing Conversation's name
- **THEN** loading it SHALL return no name
- **AND** all other canonical Conversation fields SHALL remain unchanged

#### Scenario: Missing Conversation name update

- **WHEN** a caller tries to set or clear the name of a missing Conversation
- **THEN** the store SHALL throw `conversation not found`

### Requirement: Persist surface conversation preferences

The system SHALL persist optional model and thinking preferences in the surface-settings record keyed by canonical `SurfaceId`, using the dependency-provided atomic surface-settings storage. Updating either preference SHALL affect the current and future conversations on that surface without rewriting conversation state.

#### Scenario: Model preference survives rotation

- **WHEN** a surface's model preference is set and the conversation rotates
- **THEN** the surface-settings record SHALL retain the preference
- **AND** the next runtime on that surface SHALL use it

### Requirement: Migrate legacy lifecycle state offline

The canonical offline migration runner SHALL include lifecycle filesystem step 4, after transcript-provenance step 3, to convert legacy conversation records, bindings, model/thinking preferences, schedules, heartbeat records, and surface heartbeat prompt files to the split ownership model without deleting conversation history. The step SHALL compute and validate its complete transformation before its first write, then atomically replace each target file. It SHALL detect a conversation referenced by multiple surface bindings and fail with the conversation ID plus every candidate SurfaceId so the operator can choose the retained binding explicitly. Expected missing files may be skipped; invalid data and non-`ENOENT` filesystem errors MUST fail loudly. `CURRENT_STATE_VERSION` SHALL advance from 3 to 4 only after success. Startup MUST NOT invoke the step and SHALL rely on the canonical state-version gate.

#### Scenario: Legacy conversation has several bindings

- **GIVEN** one legacy conversation is referenced by several migrated surface bindings
- **WHEN** the offline lifecycle migration step computes its output
- **THEN** it SHALL fail before writing any lifecycle-step output
- **AND** the diagnostic SHALL identify the conversation and every candidate SurfaceId
- **AND** no binding SHALL be selected by lexical order, map order, or guessed recency
- **AND** the conversation directory and binding file SHALL remain unchanged

#### Scenario: Offline lifecycle migration succeeds

- **GIVEN** the service is stopped and the canonical migration command has backed up state
- **WHEN** the lifecycle step validates unambiguous legacy state and writes every computed output
- **THEN** conversation history SHALL remain present
- **AND** bindings, preferences, schedules, heartbeat records, and heartbeat prompt files SHALL have their canonical owners
- **AND** the canonical runner SHALL advance `stateVersion` only after the step succeeds

#### Scenario: Version 3 deployment migrates

- **GIVEN** filesystem `stateVersion` is 3
- **WHEN** the operator runs `bun run migrate` with the service stopped
- **THEN** lifecycle step 4 SHALL run exactly once
- **AND** `stateVersion` SHALL become 4 only after the step succeeds

#### Scenario: Startup sees the old state version

- **WHEN** Goblin starts before the lifecycle migration step has advanced `stateVersion` to 4
- **THEN** startup SHALL refuse to poll
- **AND** SHALL direct the operator to run `bun run migrate` with the service stopped

### Requirement: Scheduled turns stay bound to their captured Surface

A scheduled occurrence SHALL address its captured surface and resolve that surface's current binding non-mutatively at dispatch time. If the surface is unbound, the occurrence SHALL remain pending and enabled, SHALL NOT create a conversation, and SHALL be eligible on a later tick. If a conversation is bound, the scheduler SHALL dispatch through that conversation's current runtime without comparing against a creation-time conversation ID.

#### Scenario: Surface has a current conversation

- **WHEN** a schedule is due and its surface has a bound compatible conversation
- **THEN** the scheduler SHALL dispatch the prompt as a fresh turn through that conversation runtime

#### Scenario: Surface is temporarily unbound

- **WHEN** a schedule is due and inspection reports no binding
- **THEN** the scheduler SHALL leave the occurrence due and enabled
- **AND** SHALL NOT create a conversation or disable the schedule

### Requirement: Heartbeat schedule is explicit and Surface-owned

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

## MODIFIED Requirements

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

### Requirement: Topic settings file

The dependency-provided surface-settings store SHALL remain the atomic persistence module for per-surface execution assignment and pending notices, and SHALL additionally hold model and thinking preferences keyed by canonical `SurfaceId`. Missing or malformed JSON SHALL use the established default-and-warning policy; non-`ENOENT`, non-syntax errors MUST propagate.

#### Scenario: Surface settings load

- **WHEN** settings are read for a surface
- **THEN** project assignment, model preference, thinking preference, and pending notices SHALL resolve from the same canonical `SurfaceId` slot

## REMOVED Requirements

### Requirement: Resolve sessions from complete Surface values

### Requirement: Surface-based creation and rebinding preserve conversation identity

### Requirement: Peek binding is complete and non-mutating

### Requirement: Export session types and manager

### Requirement: Persist session state atomically

### Requirement: Scheduled turns stay bound to their captured session surface

### Requirement: Heartbeat schedule is explicit and session-scoped

### Requirement: Generate short session IDs

### Requirement: Create session filesystem layout

### Requirement: List all sessions

### Requirement: Return empty array for missing sessions directory

### Requirement: List resumable sessions excludes archive

### Requirement: Persist session titles

### Requirement: Session-scoped heartbeat prompt file path

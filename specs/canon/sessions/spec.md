# sessions

## Requirements

### Requirement: Generate short session IDs

The system SHALL generate 10-character hexadecimal session IDs from UUID v4, providing ~1.1 trillion combinations.

#### Scenario: New session created

- **WHEN** `createForChat()` is called
- **THEN** the resulting session SHALL have an `id` of exactly 10 lowercase hex characters

### Requirement: Resolve DM sessions only when explicitly bound

The system SHALL return `null` when resolving a DM locator that has no active binding (user must explicitly create with `/new`).

#### Scenario: DM with no binding

- **WHEN** `resolve()` is called with a DM locator (no topicId)
- **AND** no binding exists for that chatId
- **THEN** it SHALL return `null`

#### Scenario: DM with active binding

- **WHEN** `resolve()` is called with a DM locator that has a binding
- **THEN** it SHALL return the `SessionState` from the bound session

### Requirement: Auto-create sessions for topics on first resolve

The system SHALL automatically create a new session when resolving a topic locator for the first time. The new session's `state.json` SHALL NOT include a `projectDir` field.

#### Scenario: Topic first message

- **WHEN** `resolve()` is called with a topic locator (has topicId)
- **AND** no binding exists for that chatId+topicId
- **THEN** it SHALL create a new session
- **AND** the session's `state.json` SHALL NOT contain `projectDir`
- **AND** `resolve()` SHALL return the session state

#### Scenario: Topic with binding-scoped projectDir

- **WHEN** `resolve()` is called for a topic with `projectDir` set in `topic-settings.json`
- **THEN** it SHALL return the session state without `projectDir`
- **AND** `getProjectDir(locator)` SHALL return the projectDir from the binding

#### Scenario: Topic subsequent message

- **WHEN** `resolve()` is called for a topic that already has a binding
- **AND** the bound session's `state.json` exists
- **THEN** it SHALL return the existing session state

### Requirement: Handle stale bindings for DMs

The system SHALL detect and clear stale DM bindings (where state.json is missing) during resolution.

#### Scenario: Stale DM binding

- **WHEN** `resolve()` is called for a DM with a binding
- **AND** the bound session's state.json is missing
- **THEN** it SHALL log a warning, remove the binding from config.json, and return `null`

### Requirement: Handle stale bindings for topics by recreating

The system SHALL auto-recreate topic sessions when the bound session is stale. The recreated session SHALL NOT include a `projectDir` field in `state.json`.

#### Scenario: Stale topic binding

- **WHEN** `resolve()` is called for a topic with a binding
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, create a new session, update the binding, and return the new state
- **AND** the new session's `state.json` SHALL NOT contain `projectDir`

### Requirement: Persist session state atomically

The system SHALL write session state using atomic write (tmp file + rename) to prevent corruption.

#### Scenario: Session state saved

- **WHEN** `saveState()` is called
- **THEN** it SHALL write to a temp file named `.state-<id>.tmp` in the session directory
- **AND** rename the temp file to `state.json` atomically

### Requirement: Persist bindings atomically

The system SHALL write config.json (bindings) using atomic write with unique temp names.

#### Scenario: Bindings saved

- **WHEN** `saveBindings()` is called
- **THEN** it SHALL write to a temp file with name `.config.<random8chars>.tmp`
- **AND** rename the temp file to `config.json` atomically

### Requirement: Create session filesystem layout

The system SHALL create the complete filesystem structure when creating a session.

#### Scenario: Session created

- **WHEN** `createForChat()` is called
- **THEN** it SHALL create: `sessions/<id>/` directory, `sessions/<id>/workdir/` directory, `sessions/<id>/events.jsonl` (empty), `sessions/<id>/transcript.jsonl` (empty), and `sessions/<id>/state.json`

### Requirement: Write transcript entries on message completion

The system SHALL append final message entries to `transcript.jsonl` when pi emits `message_end` events.

#### Scenario: Message end event received

- **WHEN** a `message_end` event is received from pi
- **THEN** the system SHALL extract the `message` field
- **AND** normalize it into a transcript entry with `ts`, `role`, `timestamp`, and `content`
- **AND** for assistant messages, include `api`, `provider`, `model`, `stopReason`, and `errorMessage` if present
- **AND** for tool result messages, include `toolCallId`, `toolName`, and `isError`
- **AND** drop noisy/sensitive payloads: image base64 data (keep `mimeType`), provider signatures (`textSignature`, `thinkingSignature`), and tool result `details`
- **AND** append the entry as a single JSONL line to `transcript.jsonl`

#### Scenario: Non-message_end events received

- **WHEN** an event type other than `message_end` is received
- **THEN** the system SHALL NOT write to `transcript.jsonl`

### Requirement: Support session rebinding for DMs

The system SHALL allow creating new DM sessions even when one exists (orphaning the old session).

#### Scenario: DM session rebound

- **WHEN** `createForChat()` is called for a DM that already has a session
- **THEN** it SHALL create a new session with a new ID
- **AND** update the binding to point to the new session
- **AND** leave the old session directory intact (orphaned)

### Requirement: List all sessions

The system SHALL provide a method to list all sessions sorted by creation time.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found in the sessions directory
- **AND** results SHALL be sorted by `createdAt` ascending (oldest first)
- **AND** orphaned sessions (no binding) SHALL be included

### Requirement: Return empty array for missing sessions directory

The system SHALL handle ENOENT when listing sessions gracefully.

#### Scenario: List with no sessions dir

- **WHEN** `list()` is called and the sessions directory does not exist
- **THEN** it SHALL return an empty array `[]` without throwing

### Requirement: Export session types and manager

The system SHALL export the public API from `src/sessions/mod.ts`.

#### Scenario: Module imports from sessions/

- **WHEN** a module imports from `"./sessions/mod.ts"`
- **THEN** it SHALL have access to `SessionManager` class and types `ChatLocator`, `SessionState`

### Requirement: Persist session titles

The session manager SHALL allow setting or clearing `SessionState.title` for an existing session and persist the updated state atomically.

#### Scenario: Title set

- **WHEN** `setTitle(sessionId, "memory refactor")` is called for an existing session
- **THEN** `sessions/<id>/state.json` SHALL contain `"title": "memory refactor"`
- **AND** resolving that session SHALL return the updated title

#### Scenario: Missing session title update

- **WHEN** `setTitle()` is called for a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: Bind existing sessions to chat surfaces

The session manager SHALL allow binding an existing resumable session to a DM, supergroup, or forum topic locator without creating a new session and without deleting or archiving the session previously bound to that surface.

#### Scenario: Bind existing session to DM

- **WHEN** `bindExistingToChat(sessionId, { chatId })` is called for an existing session
- **THEN** the DM binding for `chatId` SHALL point to `sessionId`
- **AND** the previously bound session directory SHALL remain intact

#### Scenario: Bind existing session to topic

- **WHEN** `bindExistingToChat(sessionId, { chatId, topicId })` is called for an existing session
- **THEN** the topic binding for `(chatId, topicId)` SHALL point to `sessionId`

#### Scenario: Bind missing session

- **WHEN** `bindExistingToChat()` is called for a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: Session rebinding leaves old session resumable

When creating a new session for a DM that already has one, the old session SHALL remain under `sessions/<old-id>/` as an unbound resumable session.

#### Scenario: DM session rebound

- **WHEN** `createForChat()` is called for a DM that already has a session
- **THEN** it SHALL create a new session with a new ID
- **AND** update the binding to point to the new session
- **AND** leave the old session directory intact as a resumable unbound session

### Requirement: List resumable sessions excludes archive

The session list SHALL include unbound sessions and exclude archived sessions under `sessions/archive/<id>/`.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found directly under the sessions directory
- **AND** unbound sessions SHALL be included
- **AND** archived sessions SHALL be excluded

### Requirement: Topic settings file

The system SHALL maintain a `topic-settings.json` file under `$GOBLIN_HOME` that stores per-chat-surface settings including `projectDir`.

#### Scenario: Load topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `topic-settings.json` exists
- **THEN** it SHALL return the parsed settings

#### Scenario: Default topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `topic-settings.json` does not exist
- **THEN** it SHALL return an empty default structure

#### Scenario: Malformed topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `topic-settings.json` exists but contains invalid JSON
- **THEN** it SHALL return an empty default structure
- **AND** it SHOULD log a warning

### Requirement: Get projectDir from binding

The `SessionManager` SHALL provide a `getProjectDir(locator)` method that returns the `projectDir` for a chat surface from `topic-settings.json`, or `undefined` if none is set.

#### Scenario: Topic with projectDir

- **WHEN** `getProjectDir({ chatId: -1003958530002, topicId: 180 })` is called
- **AND** the binding has `projectDir: "/home/daniel/project"`
- **THEN** it SHALL return `"/home/daniel/project"`

#### Scenario: Topic without projectDir

- **WHEN** `getProjectDir({ chatId: -1003958530002, topicId: 180 })` is called
- **AND** no `projectDir` is set for that topic
- **THEN** it SHALL return `undefined`

#### Scenario: DM with projectDir

- **WHEN** `getProjectDir({ chatId: 889192981 })` is called
- **AND** the DM binding has `projectDir: "/home/daniel/dm-project"`
- **THEN** it SHALL return `"/home/daniel/dm-project"`

#### Scenario: DM without projectDir

- **WHEN** `getProjectDir({ chatId: 889192981 })` is called
- **AND** no `projectDir` is set for that DM
- **THEN** it SHALL return `undefined`

#### Scenario: Supergroup with projectDir

- **WHEN** `getProjectDir({ chatId: -1003958530002 })` is called for a supergroup
- **AND** the supergroup binding has `projectDir: "/home/daniel/sg-project"`
- **THEN** it SHALL return `"/home/daniel/sg-project"`

#### Scenario: Supergroup without projectDir

- **WHEN** `getProjectDir({ chatId: -1003958530002 })` is called for a supergroup
- **AND** no `projectDir` is set for that supergroup
- **THEN** it SHALL return `undefined`

### Requirement: Bind projectDir to chat surface

The `SessionManager` SHALL provide a `bindProjectDir(locator, projectDir)` method that atomically writes the `projectDir` for a chat surface to `topic-settings.json`.

#### Scenario: Set topic projectDir

- **WHEN** `bindProjectDir({ chatId: -1003958530002, topicId: 180 }, "/home/daniel/project")` is called
- **THEN** `topic-settings.json` SHALL contain the projectDir for that topic

#### Scenario: Clear topic projectDir

- **WHEN** `bindProjectDir({ chatId: -1003958530002, topicId: 180 }, undefined)` is called
- **THEN** the projectDir for that topic SHALL be removed from `topic-settings.json`

### Requirement: Topic settings atomic write

`topic-settings.json` SHALL be written using atomic write (tmp file + rename).

#### Scenario: Save topic settings

- **WHEN** `saveTopicSettings()` is called
- **THEN** it SHALL write to a temp file with a random suffix
- **AND** rename it to `topic-settings.json` atomically

### Requirement: Persist scheduled turn definitions

The system SHALL persist scheduled turn definitions in a JSON file under `GOBLIN_HOME` using atomic write semantics. Each schedule SHALL contain an id, session id, captured `ChatLocator`, kind, enabled state, next run timestamp, optional recurrence interval, creation timestamp, and optional last-run metadata. One-shot and recurring schedules SHALL additionally store user-supplied prompt text; heartbeat schedules SHALL store no user prompt text (the heartbeat prompt is a system-owned constant defined in the scheduler loop). The schedule store MUST NOT live inside an individual session directory, because schedules need to be discoverable at startup before any runner is created.

#### Scenario: One-shot schedule persisted

- **WHEN** a user creates a one-shot schedule for an active session
- **THEN** the schedule store SHALL contain a schedule with that session id, locator, prompt text, `kind = "once"`, `enabled = true`, and `nextRunAt`
- **AND** the file write SHALL use the project's atomic write pattern

#### Scenario: Recurring schedule persisted

- **WHEN** a user creates a recurring schedule with interval 2 hours
- **THEN** the schedule store SHALL contain `kind = "recurring"` and `intervalMs = 7200000`

#### Scenario: Missing schedule store

- **WHEN** the scheduler starts and the schedule store file does not exist
- **THEN** it SHALL treat the store as empty without throwing

#### Scenario: Malformed schedule store

- **WHEN** the schedule store file contains invalid JSON
- **THEN** startup SHALL log a warning and treat the store as empty

### Requirement: Scheduled turns stay bound to their captured session surface

A scheduled turn SHALL run only when the captured session id is still the active binding for the captured `ChatLocator`. Binding validation SHALL use a non-mutating peek (`SessionManager.peekBinding(loc)`) that reads bindings and state without auto-creating sessions. The scheduler MUST NOT use `SessionManager.resolve(loc)` for binding validation because it auto-creates sessions for topic and supergroup locators. If the session was archived, rebound, or otherwise no longer matches the locator, the scheduler SHALL disable the schedule and SHALL NOT dispatch the prompt.

#### Scenario: Session still bound

- **WHEN** a due schedule's captured locator still resolves to the captured session id via `peekBinding`
- **THEN** the scheduler SHALL dispatch the scheduled prompt as a fresh turn for that session

#### Scenario: Session no longer bound

- **WHEN** a due schedule's captured locator resolves to a different session id or no session via `peekBinding`
- **THEN** the scheduler SHALL disable the schedule
- **AND** SHALL record a last-run status with `outcome: "binding-mismatch"`
- **AND** SHALL NOT prompt the old session

#### Scenario: Archived session skipped

- **WHEN** a due schedule's captured locator resolves to no session via `peekBinding` because the session was archived (binding cleared by `archive()`)
- **THEN** the scheduler SHALL disable the schedule
- **AND** SHALL record a last-run status with `outcome: "archived"`
- **AND** SHALL NOT recreate or resume the archived session
- **AND** SHALL NOT call `SessionManager.resolve()` which would auto-create a new session for topic/supergroup locators

### Requirement: Heartbeat schedule is explicit and session-scoped

The system SHALL represent heartbeat as an explicit session-scoped schedule kind. Heartbeat SHALL be disabled by default. Enabling heartbeat without an interval SHALL use a 30-minute interval. The heartbeat prompt SHALL be generated by the system, prefixed with the literal marker `[heartbeat]`, and SHALL ask Goblin whether there is anything useful, timely, or important to say for the current session; it MUST NOT claim a user asked a new question. The `[heartbeat]` prefix SHALL make the prompt distinguishable from user-authored text at the agent layer and in transcripts.

#### Scenario: Heartbeat default disabled

- **WHEN** a new session is created
- **THEN** no heartbeat schedule SHALL exist for that session

#### Scenario: Heartbeat enabled with default interval

- **WHEN** the user enables heartbeat without specifying an interval
- **THEN** the schedule store SHALL contain an enabled heartbeat schedule for that session with `intervalMs = 1800000`

#### Scenario: Heartbeat due turn

- **WHEN** a heartbeat schedule is due and the session remains bound
- **THEN** the scheduler SHALL dispatch a fresh turn with the heartbeat prompt
- **AND** the prompt SHALL be distinguishable from user-authored text

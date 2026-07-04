# sessions

## MODIFIED Requirements

### Requirement: Persist bindings atomically

The system SHALL write `state/bindings.json` (session bindings) using atomic write with unique temp names.

#### Scenario: Bindings saved

- **WHEN** `saveBindings()` is called
- **THEN** it SHALL write to a temp file with name `.bindings.<random8chars>.tmp` in `state/`
- **AND** rename the temp file to `state/bindings.json` atomically

### Requirement: Create session filesystem layout

The system SHALL create the complete filesystem structure when creating a session.

#### Scenario: Session created

- **WHEN** `createForChat()` is called
- **THEN** it SHALL create: `state/sessions/<id>/` directory, `state/sessions/<id>/workdir/` directory, `state/sessions/<id>/events.jsonl` (empty), `state/sessions/<id>/transcript.jsonl` (empty), and `state/sessions/<id>/state.json`

### Requirement: Topic settings file

The system SHALL maintain a `state/topic-settings.json` file under `$GOBLIN_HOME` that stores per-chat-surface settings including `projectDir`.

#### Scenario: Load topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` exists
- **THEN** it SHALL return the parsed settings

#### Scenario: Default topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` does not exist
- **THEN** it SHALL return an empty default structure

#### Scenario: Malformed topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` exists but contains invalid JSON
- **THEN** it SHALL return an empty default structure
- **AND** it SHOULD log a warning

### Requirement: Topic settings atomic write

`state/topic-settings.json` SHALL be written using atomic write (tmp file + rename).

#### Scenario: Save topic settings

- **WHEN** `saveTopicSettings()` is called
- **THEN** it SHALL write to a temp file with a random suffix in `state/`
- **AND** rename it to `state/topic-settings.json` atomically

### Requirement: List resumable sessions excludes archive

The session list SHALL include unbound sessions and exclude archived sessions under `state/sessions/archive/<id>/`.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found directly under the `state/sessions/` directory
- **AND** unbound sessions SHALL be included
- **AND** archived sessions SHALL be excluded

### Requirement: Session rebinding leaves old session resumable

When creating a new session for a DM that already has one, the old session SHALL remain under `state/sessions/<old-id>/` as an unbound resumable session.

#### Scenario: DM session rebound

- **WHEN** `createForChat()` is called for a DM that already has a session
- **THEN** it SHALL create a new session with a new ID
- **AND** update the binding to point to the new session
- **AND** leave the old session directory intact as a resumable unbound session

### Requirement: Handle stale bindings for DMs

The system SHALL detect and clear stale DM bindings (where state.json is missing) during resolution.

#### Scenario: Stale DM binding

- **WHEN** `resolve()` is called for a DM with a binding
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, remove the binding from `state/bindings.json`, and return `null`

### Requirement: Persist session titles

The session manager SHALL allow setting or clearing `SessionState.title` for an existing session and persist the updated state atomically.

#### Scenario: Title set

- **WHEN** `setTitle(sessionId, "memory refactor")` is called for an existing session
- **THEN** `state/sessions/<id>/state.json` SHALL contain `"title": "memory refactor"`
- **AND** resolving that session SHALL return the updated title

#### Scenario: Missing session title update

- **WHEN** `setTitle()` is called for a missing session ID
- **THEN** it SHALL throw `session not found`

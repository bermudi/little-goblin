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

The system SHALL automatically create a new session when resolving a topic locator for the first time.

#### Scenario: Topic first message

- **WHEN** `resolve()` is called with a topic locator (has topicId)
- **AND** no binding exists for that chatId+topicId
- **THEN** it SHALL create a new session and return its state

#### Scenario: Topic subsequent message

- **WHEN** `resolve()` is called with a topic locator that already has a binding
- **THEN** it SHALL return the existing session state

### Requirement: Handle stale bindings for DMs

The system SHALL detect and clear stale DM bindings (where state.json is missing) during resolution.

#### Scenario: Stale DM binding

- **WHEN** `resolve()` is called for a DM with a binding
- **AND** the bound session's state.json is missing
- **THEN** it SHALL log a warning, remove the binding from config.json, and return `null`

### Requirement: Handle stale bindings for topics by recreating

The system SHALL auto-recreate topic sessions when the bound session is stale.

#### Scenario: Stale topic binding

- **WHEN** `resolve()` is called for a topic with a binding
- **AND** the bound session's state.json is missing
- **THEN** it SHALL log a warning, create a new session, update the binding, and return the new state

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

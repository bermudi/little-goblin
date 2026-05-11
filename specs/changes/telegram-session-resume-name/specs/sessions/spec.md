# sessions

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Support session rebinding for DMs

The system SHALL allow creating new DM sessions even when one exists. Creating a new session SHALL rebind the DM to the new session and leave the old session under `sessions/<old-id>/` as an unbound resumable session.

#### Scenario: DM session rebound

- **WHEN** `createForChat()` is called for a DM that already has a session
- **THEN** it SHALL create a new session with a new ID
- **AND** update the binding to point to the new session
- **AND** leave the old session directory intact as a resumable unbound session

### Requirement: List resumable sessions

The system SHALL provide a method to list all resumable sessions sorted by creation time. A resumable session is a direct child of `sessions/<id>/`; archived sessions under `sessions/archive/<id>/` are excluded.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found directly under the sessions directory
- **AND** results SHALL be sorted by `createdAt` ascending (oldest first)
- **AND** unbound sessions SHALL be included
- **AND** archived sessions SHALL be excluded

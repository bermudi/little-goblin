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

The session manager SHALL allow binding an existing active session to a DM, supergroup, or forum topic locator without creating a new session and without deleting the session previously bound to that surface.

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

# sessions

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Handle stale bindings for topics by recreating

The system SHALL auto-recreate topic sessions when the bound session is stale. The recreated session SHALL NOT include a `projectDir` field in `state.json`.

#### Scenario: Stale topic binding
- **WHEN** `resolve()` is called for a topic with a binding
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, create a new session, update the binding, and return the new state
- **AND** the new session's `state.json` SHALL NOT contain `projectDir`


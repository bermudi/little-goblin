# commands

## Requirements

### Requirement: Register command handlers on bot

The system SHALL register all command handlers in a single location.

#### Scenario: Bot initialized

- **WHEN** `registerCommands()` is called with a Bot instance and SessionManager
- **THEN** it SHALL register handlers for `/ping`, `/new`, and `/start` commands

### Requirement: Implement /ping command

The system SHALL provide a `/ping` command that responds with user and chat information.

#### Scenario: /ping in DM

- **WHEN** a user sends `/ping` in a private chat
- **THEN** the bot SHALL reply with: `pong 🐲\nuser: <userId>\nchat: private`

#### Scenario: /ping in topic

- **WHEN** a user sends `/ping` in a forum topic
- **THEN** the bot SHALL reply with: `pong 🐲\nuser: <userId>\nchat: <type>\ntopic: <topicId>`
- **AND** the reply SHALL be sent to the correct topic thread

### Requirement: Implement /new command for DM session creation

The system SHALL provide a `/new` command that creates a new session in private chats.

#### Scenario: /new in private chat

- **WHEN** a user sends `/new` in a private chat (DM)
- **THEN** the bot SHALL create a new session via `SessionManager.createForChat()`
- **AND** reply with: `Created new session \`<id>\`\nWorkdir: \`sessions/<id>/workdir\`` using MarkdownV2 parse mode

### Requirement: Reject /new in non-forum groups

The system SHALL reject `/new` in plain group chats that are not forums.

#### Scenario: /new in plain group

- **WHEN** a user sends `/new` in a non-private, non-topic chat (e.g., basic group)
- **THEN** the bot SHALL reply with: `Use /new in a private chat or a forum topic.`

### Requirement: Warn when /new used in topic

The system SHALL inform users that topics are already sessions.

#### Scenario: /new in forum topic

- **WHEN** a user sends `/new` in a forum topic
- **THEN** the bot SHALL reply with: `This topic is already its own session. No need for /new here.`

### Requirement: Handle indeterminate chat context gracefully

The system SHALL handle cases where chat context cannot be determined.

#### Scenario: /new with no locator

- **WHEN** `locatorFromCtx()` returns `null` for a /new command
- **THEN** the bot SHALL reply with: `Unable to determine chat context.`

### Requirement: Implement /start command for DM session creation

The system SHALL provide a `/start` command that creates a new session in private chats and welcomes the user.

#### Scenario: /start in private chat

- **WHEN** a user sends `/start` in a private chat (DM)
- **THEN** the bot SHALL create a new session via `SessionManager.createForChat()`
- **AND** reply with a welcome message that includes the session ID

### Requirement: Reject /start in non-forum groups

The system SHALL reject `/start` in plain group chats that are not forums.

#### Scenario: /start in plain group

- **WHEN** a user sends `/start` in a non-private, non-topic chat (e.g., basic group)
- **THEN** the bot SHALL reply with: `Use /start in a private chat or a forum topic.`

### Requirement: Handle /start in forum topic

The system SHALL inform users that topics are already sessions when `/start` is used in a topic.

#### Scenario: /start in forum topic

- **WHEN** a user sends `/start` in a forum topic
- **THEN** the bot SHALL reply with: `This topic is already its own session. Just start typing!`

### Requirement: Handle indeterminate chat context for /start

The system SHALL handle cases where chat context cannot be determined for `/start`.

#### Scenario: /start with no locator

- **WHEN** `locatorFromCtx()` returns `null` for a `/start` command
- **THEN** the bot SHALL reply with: `Unable to determine chat context.`

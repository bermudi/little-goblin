# telegram

## ADDED Requirements

### Requirement: Build allowlist middleware that silently drops non-allowed users
The system SHALL provide middleware that drops messages from users not in the configured allowlist without responding.

#### Scenario: Message from allowed user
- **WHEN** a message is received from a user ID that exists in `allowedTgUserIds`
- **THEN** the middleware SHALL call `next()` to continue processing

#### Scenario: Message from non-allowed user
- **WHEN** a message is received from a user ID not in `allowedTgUserIds`
- **THEN** the middleware SHALL return without calling `next()` (message dropped)
- **AND** no response SHALL be sent to the user
- **AND** a debug log SHALL be emitted with userId, username, and chatId

#### Scenario: Message with no user information
- **WHEN** a message is received where `ctx.from` is undefined
- **THEN** the middleware SHALL treat it as non-allowed and drop the message

### Requirement: Derive ChatLocator from grammy context
The system SHALL derive a `ChatLocator` from a grammy Context, distinguishing between DMs and forum topics.

#### Scenario: Direct message context
- **WHEN** `locatorFromCtx()` is called with a DM context
- **THEN** it SHALL return `{ chatId: <number> }` (no topicId)

#### Scenario: Forum topic message context
- **WHEN** `locatorFromCtx()` is called with a message where `is_topic_message === true` and `message_thread_id` is a number
- **THEN** it SHALL return `{ chatId: <number>, topicId: <number> }`

#### Scenario: General topic context
- **WHEN** `locatorFromCtx()` is called with a message that has `message_thread_id` but `is_topic_message !== true`
- **THEN** it SHALL treat it as a DM (no topicId in result)

#### Scenario: Context with no chat
- **WHEN** `locatorFromCtx()` is called with a context where `ctx.chat` is undefined
- **THEN** it SHALL return `null`

### Requirement: Export telegram module public API
The system SHALL export the public API from `src/tg/mod.ts`.

#### Scenario: Module imports from tg/
- **WHEN** a module imports from `"./tg/mod.ts"`
- **THEN** it SHALL have access to `buildAllowlistMiddleware` and `locatorFromCtx`

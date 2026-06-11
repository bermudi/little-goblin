# telegram

## Requirements

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

### Requirement: Allowlist middleware caches chat member counts with TTL

The allowlist middleware SHALL cache the result of `getChatMemberCount(chatId)` per chat for 5 minutes. Within the TTL window, subsequent calls for the same chat SHALL return the cached value without hitting the Telegram API. After the TTL elapses, the next call SHALL re-fetch and refresh the cache.

#### Scenario: First call hits the API

- **WHEN** the middleware needs the member count for a chat
- **AND** no cache entry exists for that chat
- **THEN** it SHALL call `ctx.api.getChatMemberCount(chatId)`
- **AND** it SHALL store the result in the cache with the current timestamp

#### Scenario: Second call within TTL uses the cache

- **WHEN** the middleware needs the member count for a chat
- **AND** a cache entry exists for that chat with `now - fetchedAt < 5 minutes`
- **THEN** it SHALL return the cached value
- **AND** it SHALL NOT call `ctx.api.getChatMemberCount(chatId)`

#### Scenario: Call after TTL refreshes the cache

- **WHEN** the middleware needs the member count for a chat
- **AND** a cache entry exists for that chat with `now - fetchedAt >= 5 minutes`
- **THEN** it SHALL call `ctx.api.getChatMemberCount(chatId)` again
- **AND** it SHALL replace the cached value with the new result and current timestamp

#### Scenario: API error assumes large group

- **WHEN** `ctx.api.getChatMemberCount(chatId)` throws
- **THEN** the middleware SHALL assume the count is `Infinity` (i.e. treat the group as having more than 2 members)
- **AND** a warn log SHALL be emitted with the chat id and error

### Requirement: Allowlist middleware applies group-aware routing

The allowlist middleware SHALL route messages according to chat type, user allowlist membership, and the presence of a bot @mention in the message text or caption. The routing rules are:

- DMs (chat type `private`): allowed users only, no exceptions. Non-allowed users are dropped silently.
- Groups: a bot @mention in `entities` or `caption_entities` is always passed through, for any user.
- Groups (no @mention): an allowed user sending a slash command (an entity with `type === "bot_command"`) is always passed through.
- Groups (no @mention, not a slash command): an allowed user is passed through only if the group has 2 or fewer members. Otherwise dropped.
- Groups (no @mention, not a slash command, non-allowed user): dropped.

#### Scenario: DM from allowed user

- **WHEN** a message arrives in a `private` chat from a user id in `allowedTgUserIds`
- **THEN** `next()` SHALL be called

#### Scenario: DM from non-allowed user

- **WHEN** a message arrives in a `private` chat from a user id NOT in `allowedTgUserIds`
- **THEN** `next()` SHALL NOT be called
- **AND** a debug log SHALL be emitted with the user id, username, and chat id

#### Scenario: Group message with bot @mention

- **WHEN** a message arrives in a non-private chat
- **AND** the message entities (or caption entities) include a `mention` matching `@<botUsername>` or a `text_mention` matching `ctx.me.id`
- **THEN** `next()` SHALL be called regardless of user allowlist membership

#### Scenario: Allowed user slash command in large group

- **WHEN** a message arrives in a non-private chat with member count > 2
- **AND** the sender is in `allowedTgUserIds`
- **AND** the message entities include a `bot_command` entity
- **THEN** `next()` SHALL be called

#### Scenario: Allowed user text in small group

- **WHEN** a message arrives in a non-private chat with member count <= 2
- **AND** the sender is in `allowedTgUserIds`
- **AND** the message is not a bot @mention
- **THEN** `next()` SHALL be called

#### Scenario: Allowed user text in large group without mention

- **WHEN** a message arrives in a non-private chat with member count > 2
- **AND** the sender is in `allowedTgUserIds`
- **AND** the message has no bot @mention
- **AND** the message is not a slash command
- **THEN** `next()` SHALL NOT be called
- **AND** a debug log SHALL be emitted with user id, chat id, and member count

#### Scenario: Non-allowed user in group without mention

- **WHEN** a message arrives in a non-private chat
- **AND** the sender is NOT in `allowedTgUserIds`
- **AND** the message has no bot @mention
- **THEN** `next()` SHALL NOT be called
- **AND** a debug log SHALL be emitted with user id, username, and chat id

#### Scenario: Non-message updates pass through

- **WHEN** an update arrives where `ctx.chat` or `ctx.from` is undefined (e.g. callback queries, inline queries)
- **THEN** `next()` SHALL be called regardless of allowlist — the access control logic only applies to message updates

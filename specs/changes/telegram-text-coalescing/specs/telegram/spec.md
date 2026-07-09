# telegram

## ADDED Requirements

### Requirement: Text coalescer detects and merges Telegram-split messages

The system SHALL provide a text coalescer (`src/tg/coalesce.ts`) that detects messages Telegram clients split at the 4096-character limit and merges consecutive fragments into a single logical message before dispatching to intake. A fragment SHALL be considered a likely split first-half when its length is at or above `TEXT_SPLIT_THRESHOLD` (4000 chars). When such a fragment arrives, the coalescer SHALL begin buffering; subsequent fragments SHALL be appended to the buffer when they arrive from the same sender within the same chat/topic, with a Telegram `message_id` exactly one greater than the last buffered fragment, and within `TEXT_SPLIT_WINDOW_MS` (1200 ms) of the prior fragment. Appended fragments SHALL extend the trailing debounce window. The coalescer SHALL concatenate buffered fragments with no separator (faithful to Telegram's hard client-side cut). The coalescer SHALL hard-cap the buffer at `MAX_FRAGMENTS` (12) fragments and `MAX_TOTAL_CHARS` (50,000) characters; reaching either cap SHALL trigger an immediate flush before buffering further text.

#### Scenario: First half of a split message opens a buffer

- **WHEN** a text message of length >= 4000 chars arrives
- **THEN** the coalescer SHALL open a buffer keyed on `(chatId, topicId, fromUserId)`
- **AND** SHALL start a trailing debounce timer of 1200 ms
- **AND** SHALL NOT immediately dispatch to `intake.handleText`

#### Scenario: Consecutive adjacent fragment extends the buffer

- **WHEN** a buffer is open for `(chatId, topicId, fromUserId)` at message_id N
- **AND** a second text message arrives from the same sender in the same chat/topic
- **AND** its `message_id` is exactly N+1
- **AND** it arrives within 1200 ms of the prior fragment
- **THEN** the coalescer SHALL append the second fragment's text to the buffer
- **AND** SHALL restart the 1200 ms debounce timer
- **AND** SHALL NOT dispatch either fragment yet

#### Scenario: Buffer flushes concatenated text as one turn

- **WHEN** the debounce timer for an open buffer elapses with no further adjacent fragment
- **THEN** the coalescer SHALL concatenate all buffered fragments with no separator
- **AND** SHALL dispatch the result to `intake.handleText` exactly once, using the first buffered `TelegramIntakeMessage`
- **AND** SHALL clear the buffer

#### Scenario: Non-adjacent message flushes pending buffer then dispatches fresh

- **WHEN** a buffer is open at message_id N
- **AND** a text message arrives whose `message_id` is greater than N+1, less than or equal to N (non-monotonic: an out-of-order, duplicate, or redelivered `message_id`), or from a different sender, or in a different chat/topic, or after the debounce window elapsed
- **THEN** the coalescer SHALL flush the pending buffer immediately (dispatch its concatenation to `intake.handleText`, using the first buffered `TelegramIntakeMessage`)
- **AND** SHALL then evaluate the incoming message independently

#### Scenario: Short message never enters the buffer

- **WHEN** a text message of length < 4000 chars arrives and no buffer is open for its `(chatId, topicId, fromUserId)` key
- **THEN** the coalescer SHALL dispatch it to `intake.handleText` immediately with no debounce

#### Scenario: Short message appends to an already-open buffer

- **WHEN** a text message of length < 4000 chars arrives
- **AND** a buffer is open for its `(chatId, topicId, fromUserId)` key at message_id N
- **AND** its `message_id` is exactly N+1 and it arrives within 1200 ms
- **THEN** the coalescer SHALL append it to the buffer (the short fragment is the tail of a split)
- **AND** SHALL restart the debounce timer

#### Scenario: Hard cap on fragments forces a flush

- **WHEN** a buffer already holds 12 fragments
- **AND** a further adjacent fragment arrives
- **THEN** the coalescer SHALL flush the 12-fragment buffer to `intake.handleText` immediately, using the first buffered `TelegramIntakeMessage`
- **AND** SHALL NOT append the 13th fragment to the flushed buffer
- **AND THEN** SHALL evaluate the 13th fragment as if fresh: open a new buffer if it is itself >= 4000 chars, or dispatch it immediately if it is short

#### Scenario: Hard cap on total characters forces a flush

- **WHEN** appending a fragment would push the buffer's total concatenated length past 50,000 chars
- **THEN** the coalescer SHALL flush the current buffer to `intake.handleText` immediately, using the first buffered `TelegramIntakeMessage`
- **AND** SHALL begin a new buffer with the incoming fragment if it is itself >= 4000 chars, or dispatch it immediately otherwise

### Requirement: Slash commands bypass and flush the coalescer

A text message whose first Telegram entity is type `bot_command` (as exposed by grammy's `ctx.msg.entities[0].type`) SHALL NOT be buffered. If a buffer is open for the same `(chatId, topicId, fromUserId)` key when such a command arrives, the coalescer SHALL flush the pending buffer to `intake.handleText` first, then dispatch the command to `intake.handleText` immediately. The order SHALL be preserved: buffered user text is dispatched before the command that arrived after it. The coalescer detects commands by entity type alone; `parseCommand` remains the authority that resolves and validates commands inside `intake.handleText`.

#### Scenario: Command with no pending buffer dispatches immediately

- **WHEN** a slash command arrives and no buffer is open
- **THEN** the coalescer SHALL dispatch it to `intake.handleText` immediately with no debounce

#### Scenario: Command flushes a pending buffer then dispatches

- **WHEN** a slash command arrives
- **AND** a buffer is open for the same key with unsent fragments
- **THEN** the coalescer SHALL flush the buffer's concatenation to `intake.handleText` first, using the first buffered `TelegramIntakeMessage`
- **AND** SHALL then dispatch the command to `intake.handleText` immediately
- **AND** the buffered text SHALL reach intake before the command

### Requirement: Coalescer is constructed once per bot and keyed per sender

`buildBot` SHALL construct a single text coalescer instance shared across all `message:text` handlers. The coalescer's buffer state SHALL be keyed on the tuple `(chatId, topicId, fromUserId)` so that splits from different users in a group, different forum topics, or different DMs never merge. The coalescer SHALL NOT key on `chatId` alone.

#### Scenario: Fragments from different senders stay separate

- **WHEN** user A sends a long message that splits, and user B sends a text in the same group chat before A's buffer flushes
- **THEN** the coalescer SHALL buffer A's fragments under A's key
- **AND** SHALL dispatch B's message immediately under B's key (no buffer, assuming it is short)
- **AND** the two senders' text SHALL NOT merge

#### Scenario: Fragments in different topics stay separate

- **WHEN** a long message splits in forum topic X
- **AND** a text arrives in forum topic Y before X's buffer flushes
- **THEN** the coalescer SHALL buffer X's fragments under `(chatId, topicX, fromUserId)`
- **AND** SHALL evaluate Y's message under the separate key `(chatId, topicY, fromUserId)`

## MODIFIED Requirements

### Requirement: Telegram intake module owns the update-to-turn seam

The system SHALL provide a Telegram intake module (`src/tg/intake.ts`) that owns "Telegram update → session turn" in domain terms. `createTelegramIntake(options)` SHALL return handlers for text, photo, document, voice, audio, and forum-topic-description updates. `src/bot.ts` (`buildBot`) SHALL be a thin grammy adapter: it SHALL construct the `Bot`, mount allowlist middleware, register grammy-side commands, construct a single text coalescer, and wire one-line `bot.on(...)` handlers that each build a `TelegramIntakeMessage` from the grammy `Context` and delegate to the intake module. The `message:text` handler SHALL route through the text coalescer, which is responsible for merging Telegram-split fragments before dispatching to `intake.handleText`. `buildBot` SHALL NOT contain turn-orchestration logic (runner creation, prompt scheduling, steer-vs-queue policy, media download, or project-file saving).

The intake module SHALL expose the turn-orchestration seam as the test surface: intake decisions SHALL be exercisable with a fake runner, a fake message (`TelegramIntakeMessage`), and a fake `Bot["api"]`, without constructing a grammy `Bot` or calling `buildBot`.

#### Scenario: bot.ts is a thin adapter

- **WHEN** `buildBot()` wires grammy handlers
- **THEN** each `bot.on(...)` handler SHALL build a `TelegramIntakeMessage` and delegate to a single `intake.*` method
- **AND** the `message:text` handler SHALL route through the text coalescer before delegating to `intake.handleText`
- **AND** `buildBot` SHALL NOT define runner-creation, prompt-scheduling, steer-vs-queue, media-download, or coalescing-buffer logic inline (the coalescer is a separate module)

#### Scenario: Intake decisions are testable without grammy

- **WHEN** an intake handler is exercised in a test
- **THEN** it SHALL accept a `TelegramIntakeMessage` carrying `locator`, `isSupergroup`, `threadId`, `reply`, and `prepare`
- **AND** it SHALL accept a fake `Bot["api"]` for media download
- **AND** it SHALL accept injectable `createAgentRunner` and `createMessageBuffer` factories
- **AND** no grammy `Bot` construction or `handleUpdate` SHALL be required

#### Scenario: Intake module surfaces

- **WHEN** `createTelegramIntake(options)` is called
- **THEN** it SHALL return `handleText`, `handlePhoto`, `handleDocument`, `handleVoice`, `handleAudio`, and `handleTopicDescription`

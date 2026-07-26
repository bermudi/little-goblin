# telegram

## ADDED Requirements

### Requirement: Telegram surfaces are complete discriminated values

The Telegram layer SHALL represent every supported delivery lane as a `Surface` discriminated union:

- `{ kind: "dm", chatId }` for a topicless private chat;
- `{ kind: "topic", container: "private" | "supergroup" | "direct-messages", chatId, topicId }` for a private-chat topic, forum-supergroup topic, or channel direct-messages topic;
- `{ kind: "supergroup", chatId }` for a topicless supergroup; and
- `{ kind: "guest", chatId }` for a guest summon in a foreign chat.

`surfaceFromCtx()` and the guest-message adapter SHALL be the only grammy-context normalization points. They SHALL validate Telegram identifiers as non-zero safe integers and topic identifiers as positive safe integers. Downstream modules SHALL receive a complete `Surface`; they SHALL NOT infer its kind from chat-ID sign, topic-ID absence, or separate `isPrivate`, `isSupergroup`, `isGuest`, or thread-ID values. Ordinary channel posts and basic-group chats remain unsupported and SHALL NOT be normalized into a misleading surface kind.

#### Scenario: Topicless private chat

- **WHEN** `surfaceFromCtx()` receives a private-chat context with no topic metadata
- **THEN** it SHALL return `{ kind: "dm", chatId }`

#### Scenario: Private-chat topic

- **WHEN** `surfaceFromCtx()` receives a private-chat message with `is_topic_message === true` and a numeric `message_thread_id`
- **THEN** it SHALL return `{ kind: "topic", container: "private", chatId, topicId: message_thread_id }`

#### Scenario: Forum-supergroup topic

- **WHEN** `surfaceFromCtx()` receives a supergroup message with `is_topic_message === true` and a numeric `message_thread_id`
- **AND** the chat is not a direct-messages chat
- **THEN** it SHALL return `{ kind: "topic", container: "supergroup", chatId, topicId: message_thread_id }`

#### Scenario: Channel direct-messages topic

- **WHEN** `surfaceFromCtx()` receives a direct-messages-chat message with a numeric `direct_messages_topic.topic_id`
- **THEN** it SHALL return `{ kind: "topic", container: "direct-messages", chatId, topicId: direct_messages_topic.topic_id }`
- **AND** it SHALL NOT treat ordinary channel posts as supported surfaces

#### Scenario: Topicless supergroup

- **WHEN** `surfaceFromCtx()` receives a supergroup context without topic metadata
- **THEN** it SHALL return `{ kind: "supergroup", chatId }`

#### Scenario: Guest summon

- **WHEN** the guest-message adapter receives a foreign `guest_message.chat.id`
- **THEN** it SHALL produce `{ kind: "guest", chatId }`
- **AND** the guest query identifier SHALL remain encapsulated in the one-shot reply closure

#### Scenario: Missing or invalid routing data

- **WHEN** normalization receives no chat, an unsupported chat type, a non-safe chat identifier, or invalid topic metadata
- **THEN** it SHALL return `null` or reject at the normalization boundary
- **AND** it SHALL NOT emit a partial surface

### Requirement: SurfaceId is canonical and reversible

The Telegram layer SHALL provide a branded `SurfaceId` and total encode/decode functions for `Surface`. The canonical version-one encoding SHALL be:

- `tg:v1:dm:<chatId>`
- `tg:v1:supergroup:<chatId>`
- `tg:v1:guest:<chatId>`
- `tg:v1:topic:<container>:<chatId>:<topicId>`

where `<container>` is `private`, `supergroup`, or `direct-messages`, and every numeric component is canonical base-10 integer text. Encoding SHALL validate the value before returning an ID. Decoding SHALL reject malformed, non-canonical, unknown-version, unknown-kind, unsafe, zero chat, and non-positive topic values. `SurfaceId` SHALL be the equality and key representation for surface-addressed maps, persisted references, logs, and coalescing keys.

#### Scenario: Every surface round-trips

- **WHEN** any valid `Surface` is encoded and the resulting `SurfaceId` is decoded
- **THEN** the decoded value SHALL equal the original surface in kind, container when present, `chatId`, and `topicId` when present

#### Scenario: Same numbers in different kinds remain distinct

- **WHEN** a DM and guest surface have the same numeric `chatId`
- **THEN** their `SurfaceId` values SHALL differ
- **AND** decoding each ID SHALL recover its original kind

#### Scenario: Topic containers remain distinct

- **WHEN** private, supergroup, and direct-messages topic surfaces share the same numeric `chatId` and `topicId`
- **THEN** all three `SurfaceId` values SHALL differ

#### Scenario: Invalid identifier is rejected

- **WHEN** encoding or decoding encounters a fractional, non-finite, unsafe, zero chat, non-positive topic, exponent-form, padded, or otherwise non-canonical identifier
- **THEN** it SHALL reject the value
- **AND** it SHALL NOT create a `SurfaceId`

### Requirement: Telegram adapter derives delivery parameters from Surface

Telegram send/edit adapters SHALL accept a complete `Surface` and derive the API target and topic parameters internally. Private and forum-supergroup topics SHALL use `message_thread_id`; direct-messages topics SHALL use `direct_messages_topic_id`; topicless DM and supergroup surfaces SHALL use neither. Guest surfaces SHALL use their encapsulated `answerGuestQuery` callback rather than normal chat send methods. Domain modules SHALL NOT construct either topic parameter.

#### Scenario: Forum or private topic delivery

- **WHEN** the Telegram adapter sends to a topic whose container is `private` or `supergroup`
- **THEN** it SHALL target the surface `chatId` with `message_thread_id = topicId`
- **AND** it SHALL NOT set `direct_messages_topic_id`

#### Scenario: Direct-messages topic delivery

- **WHEN** the Telegram adapter sends to a `direct-messages` topic
- **THEN** it SHALL target the surface `chatId` with `direct_messages_topic_id = topicId`
- **AND** it SHALL NOT set `message_thread_id`

#### Scenario: Topicless delivery

- **WHEN** the Telegram adapter sends to a DM or topicless supergroup surface
- **THEN** it SHALL target the surface `chatId` without either topic parameter

#### Scenario: Guest delivery

- **WHEN** intake completes a guest turn
- **THEN** it SHALL reply once through the guest surface's one-shot reply callback
- **AND** it SHALL NOT call a normal Telegram send method for the foreign chat ID

## MODIFIED Requirements

### Requirement: Export telegram module public API

The system SHALL export the public Telegram API from `src/tg/mod.ts`, including `buildAllowlistMiddleware`, `Surface`, `SurfaceId`, `surfaceFromCtx`, the guest-surface normalizer, and the canonical SurfaceId encode/decode functions. `locatorFromCtx` and `ChatLocator` SHALL NOT remain as domain-facing compatibility APIs.

#### Scenario: Module imports from tg

- **WHEN** a module imports from `"./tg/mod.ts"`
- **THEN** it SHALL have access to the surface types, normalizers, codecs, and `buildAllowlistMiddleware`
- **AND** it SHALL NOT need a separate chat-kind flag to use a surface

### Requirement: Telegram intake module owns the update-to-turn seam

The system SHALL provide a Telegram intake module (`src/tg/intake.ts`) that owns "Telegram update → session turn" in domain terms. `createTelegramIntake(options)` SHALL return handlers for text, photo, document, voice, audio, forum-topic-description, and guest-message updates. `src/bot.ts` (`buildBot`) SHALL remain a thin grammy adapter: it SHALL normalize each supported update to one complete `Surface`, construct one intake message, and delegate. Intake, command dispatch, orchestration, and session calls SHALL receive `Surface` rather than `ChatLocator` plus routing flags.

The intake seam SHALL remain testable with a fake runner, fake intake message, and fake `Bot["api"]`, without constructing a grammy `Bot`. An intake message SHALL carry `surface: Surface | null`, `reply`, and `prepare`; it SHALL NOT carry `isSupergroup`, `isGuest`, or `threadId` routing fields.

#### Scenario: bot.ts is a thin surface adapter

- **WHEN** `buildBot()` wires a supported Telegram update
- **THEN** the handler SHALL normalize the update to a complete `Surface` and delegate to one intake method
- **AND** it SHALL NOT reconstruct routing kind in downstream calls

#### Scenario: Intake decisions are testable without grammy

- **WHEN** an intake handler is exercised in a test
- **THEN** it SHALL accept a fake intake message carrying `surface`, `reply`, and `prepare`
- **AND** injectable runner and sink factories SHALL receive the same complete surface
- **AND** no grammy `Bot` construction or `handleUpdate` SHALL be required

#### Scenario: Intake module surfaces

- **WHEN** `createTelegramIntake(options)` is called
- **THEN** it SHALL return `handleText`, `handlePhoto`, `handleDocument`, `handleVoice`, `handleAudio`, `handleTopicDescription`, and `handleGuestMessage`

### Requirement: Intake resolves an active turn once per media update

The intake module SHALL resolve an active turn once per media update by passing the message's complete `Surface` to the session manager. The resulting active turn SHALL carry the surface, session, bound `projectDir`, and a scheduling closure. If the surface is null, intake SHALL drop the update with a debug log and no reply. If no session resolves, intake SHALL reply only for a DM surface and SHALL silently drop topic surfaces. Auto-creating surface kinds retain their session-layer behavior.

#### Scenario: Media update with no surface is dropped

- **WHEN** a media handler receives a message with `surface: null`
- **THEN** intake SHALL emit a debug log identifying the media kind
- **AND** SHALL NOT resolve a session or reply

#### Scenario: No active session in a DM

- **WHEN** a media update on a DM surface resolves no session
- **THEN** intake SHALL reply `No active session. Use /new to start one.`
- **AND** SHALL NOT schedule a turn

#### Scenario: No active session in a topic

- **WHEN** a media update on any topic surface resolves no session
- **THEN** intake SHALL NOT reply
- **AND** SHALL emit a debug log containing the canonical `SurfaceId`

#### Scenario: Active turn preserves its surface

- **WHEN** a media update resolves an active session
- **THEN** the active turn, runner factory, output sink, project-setting lookup, and scheduling path SHALL receive the same complete surface

### Requirement: Guest message intake runs the agent to completion and replies once

The intake module SHALL provide `handleGuestMessage(message, text)` for a message carrying a validated guest `Surface` and a one-shot `replyVia` callback. It SHALL resolve or auto-create the guest session using that surface, run the agent to completion against a non-streaming sink, and call `replyVia` exactly once with a single article containing the accumulated text or a fixed empty-output fallback. It SHALL not use normal Telegram send methods, persist the guest query identifier, or queue behind a busy runner. A busy runner SHALL receive a one-shot busy fallback. A rejected `replyVia` SHALL be warned and swallowed.

#### Scenario: Guest surface produces one reply

- **WHEN** `handleGuestMessage` receives a valid guest surface and the turn produces text
- **THEN** intake SHALL resolve the session with that complete surface
- **AND** SHALL call `replyVia` exactly once with the full accumulated text
- **AND** SHALL NOT call a normal send method for the foreign chat

#### Scenario: Empty agent output sends fallback

- **WHEN** a guest turn completes with empty output
- **THEN** intake SHALL call `replyVia` once with a fixed acknowledgment fallback

#### Scenario: Busy guest runner does not queue

- **WHEN** the guest surface's runner is already streaming
- **THEN** intake SHALL NOT enqueue or prompt another turn
- **AND** SHALL call `replyVia` once with a busy fallback

#### Scenario: replyVia rejection is swallowed

- **WHEN** `replyVia` rejects
- **THEN** intake SHALL log a warning and SHALL NOT rethrow

#### Scenario: Guest query identifier stays encapsulated

- **WHEN** a guest turn is handled
- **THEN** the query identifier SHALL remain inside `replyVia`
- **AND** SHALL NOT appear in state, transcript, model context, or logs

#### Scenario: Guest media remains ignored

- **WHEN** a guest update contains no text
- **THEN** intake SHALL drop it with a debug log
- **AND** SHALL NOT call `replyVia` or run the agent

### Requirement: buildBot wires a guest_message grammy handler

`buildBot` SHALL register a `guest_message` handler that reads the foreign chat, normalizes it to a guest `Surface`, strips the bot mention, applies the sender prefix, and delegates to `handleGuestMessage({ surface, replyVia }, cleanedText)`. The handler SHALL keep the guest query identifier encapsulated in `replyVia` and SHALL not fire for non-guest updates.

#### Scenario: guest_message routed with complete surface

- **WHEN** an allowed text guest update reaches `buildBot`
- **THEN** the adapter SHALL pass `{ kind: "guest", chatId: guest_message.chat.id }` to intake
- **AND** SHALL pass a one-shot `replyVia` closure without naming the guest query identifier

#### Scenario: Non-guest update does not hit guest handler

- **WHEN** a regular message or other non-guest update arrives
- **THEN** the guest handler SHALL NOT fire

### Requirement: Text coalescer detects and merges Telegram-split messages

The text coalescer SHALL detect and merge Telegram-split messages as before, but its routing key SHALL be `(SurfaceId, fromUserId)`. A long fragment (at least 4000 characters) SHALL open a buffer; adjacent message IDs from the same sender and surface within 1200 ms SHALL append; buffers SHALL concatenate without separators and SHALL retain the first intake message. The existing 12-fragment and 50,000-character caps SHALL remain. Different surface kinds or topic containers SHALL never merge even when their numeric identifiers match.

#### Scenario: First half opens a surface-keyed buffer

- **WHEN** a text message of at least 4000 characters arrives
- **THEN** the coalescer SHALL open a buffer keyed by its canonical `SurfaceId` and sender ID
- **AND** SHALL NOT dispatch immediately

#### Scenario: Adjacent fragment extends the buffer

- **WHEN** an open buffer receives message ID N+1 from the same sender and `SurfaceId` within 1200 ms
- **THEN** it SHALL append the text and restart the debounce timer

#### Scenario: Buffer flushes once

- **WHEN** the debounce expires
- **THEN** the coalescer SHALL concatenate fragments without a separator and dispatch once using the first intake message

#### Scenario: Non-adjacent message flushes then evaluates fresh

- **WHEN** an incoming message is non-adjacent, non-monotonic, duplicated, or late
- **THEN** the coalescer SHALL flush the pending buffer and evaluate the incoming message independently

#### Scenario: Short message behavior is preserved

- **WHEN** a short message arrives with no matching open buffer
- **THEN** it SHALL dispatch immediately
- **AND** when it is an adjacent tail for an open buffer, it SHALL append instead

#### Scenario: Hard caps force a flush

- **WHEN** another append would exceed 12 fragments or 50,000 characters
- **THEN** the coalescer SHALL flush the current buffer and evaluate the incoming fragment as fresh

#### Scenario: Same numbers in different surfaces do not merge

- **WHEN** two fragments have the same sender and numeric chat/topic identifiers but different surface kinds or topic containers
- **THEN** their `SurfaceId` keys SHALL differ
- **AND** the fragments SHALL NOT merge

### Requirement: Coalescer is constructed once per bot and keyed per sender

`buildBot` SHALL construct one text coalescer per bot. The coalescer SHALL key buffers by `(SurfaceId, fromUserId)`, using the `SurfaceId` produced from the intake message's complete surface. It SHALL NOT build keys from optional topic IDs or chat-ID sign.

#### Scenario: Fragments from different senders stay separate

- **WHEN** different senders post fragments on the same surface
- **THEN** their buffers SHALL remain separate

#### Scenario: Fragments on different surfaces stay separate

- **WHEN** fragments arrive on different topic containers, topics, DMs, supergroups, or guest surfaces
- **THEN** they SHALL be evaluated under different canonical surface keys

## REMOVED Requirements

### Requirement: Derive ChatLocator from grammy context

### Requirement: Guest session locator keys on the foreign chat id

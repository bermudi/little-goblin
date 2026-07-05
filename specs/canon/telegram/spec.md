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
- Groups: a bot @mention or a direct reply to a bot message is always passed through, for any user. A mention is recognized in two ways: (a) a `mention` entity in `entities`/`caption_entities` whose text matches `@<botUsername>` case-insensitively, or a `text_mention` entity whose user id matches `ctx.me.id`; or (b) a plain-text `@<botUsername>` fallback when the client sent the handle without resolving it into an entity. The plain-text match is anchored on `@` and rejects handles that extend the bot's username with additional `[0-9A-Za-z_]` characters (so `@goblinbot` does not match `@goblinbot5000`). A direct reply is recognized when `reply_to_message.from.id === ctx.me.id`; a forum topic's anchor message (a `forum_topic_created` service message) is NOT treated as a reply, so ordinary messages in a bot-created topic do not wake the bot.
- Groups (no @mention, no reply-to-bot): an allowed user sending a slash command (an entity with `type === "bot_command"`) is always passed through.
- Groups (no @mention, no reply-to-bot, not a slash command): an allowed user is passed through only if the group has 2 or fewer members. Otherwise dropped.
- Groups (no @mention, no reply-to-bot, not a slash command, non-allowed user): dropped.

#### Scenario: DM from allowed user

- **WHEN** a message arrives in a `private` chat from a user id in `allowedTgUserIds`
- **THEN** `next()` SHALL be called

#### Scenario: DM from non-allowed user

- **WHEN** a message arrives in a `private` chat from a user id NOT in `allowedTgUserIds`
- **THEN** `next()` SHALL NOT be called
- **AND** a debug log SHALL be emitted with the user id, username, and chat id

#### Scenario: Group message with bot @mention

- **WHEN** a message arrives in a non-private chat
- **AND** the message entities (or caption entities) include a `mention` matching `@<botUsername>` case-insensitively, or a `text_mention` matching `ctx.me.id`
- **THEN** `next()` SHALL be called regardless of user allowlist membership

#### Scenario: Group message with plain-text @handle and no resolved entity

- **WHEN** a message arrives in a non-private chat
- **AND** the message contains a literal `@<botUsername>` in text or caption
- **AND** no `mention`/`text_mention` entity resolves to the bot (the client did not turn the handle into a clickable mention)
- **THEN** `next()` SHALL be called regardless of user allowlist membership

#### Scenario: Plain-text handle sharing the bot's prefix does not count as a mention

- **WHEN** a message arrives in a non-private chat
- **AND** the message contains a literal handle that extends `<botUsername>` with additional `[0-9A-Za-z_]` characters (e.g. `@goblinbot5000`)
- **AND** there is no other mention of the bot
- **THEN** `next()` SHALL NOT be called on the basis of that text

#### Scenario: Direct reply to a bot message in group

- **WHEN** a message arrives in a non-private chat
- **AND** `reply_to_message.from.id === ctx.me.id`
- **AND** the replied-to message is not a `forum_topic_created` service message
- **THEN** `next()` SHALL be called regardless of user allowlist membership or group size

#### Scenario: Forum topic anchor message does not count as a reply

- **WHEN** a message arrives in a non-private chat
- **AND** `reply_to_message` points at the topic anchor (a `forum_topic_created` service message)
- **AND** there is no @mention of the bot
- **THEN** `next()` SHALL NOT be called on the basis of the reply

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

### Requirement: Telegram intake module owns the update-to-turn seam

The system SHALL provide a Telegram intake module (`src/tg/intake.ts`) that owns "Telegram update → session turn" in domain terms. `createTelegramIntake(options)` SHALL return handlers for text, photo, document, voice, audio, and forum-topic-description updates. `src/bot.ts` (`buildBot`) SHALL be a thin grammy adapter: it SHALL construct the `Bot`, mount allowlist middleware, register grammy-side commands, and wire one-line `bot.on(...)` handlers that each build a `TelegramIntakeMessage` from the grammy `Context` and delegate to the intake module. `buildBot` SHALL NOT contain turn-orchestration logic (runner creation, prompt scheduling, steer-vs-queue policy, media download, or project-file saving).

The intake module SHALL expose the turn-orchestration seam as the test surface: intake decisions SHALL be exercisable with a fake runner, a fake message (`TelegramIntakeMessage`), and a fake `Bot["api"]`, without constructing a grammy `Bot` or calling `buildBot`.

#### Scenario: bot.ts is a thin adapter

- **WHEN** `buildBot()` wires grammy handlers
- **THEN** each `bot.on(...)` handler SHALL build a `TelegramIntakeMessage` and delegate to a single `intake.*` method
- **AND** `buildBot` SHALL NOT define runner-creation, prompt-scheduling, steer-vs-queue, or media-download logic inline

#### Scenario: Intake decisions are testable without grammy

- **WHEN** an intake handler is exercised in a test
- **THEN** it SHALL accept a `TelegramIntakeMessage` carrying `locator`, `isSupergroup`, `threadId`, `reply`, and `prepare`
- **AND** it SHALL accept a fake `Bot["api"]` for media download
- **AND** it SHALL accept injectable `createAgentRunner` and `createMessageBuffer` factories
- **AND** no grammy `Bot` construction or `handleUpdate` SHALL be required

#### Scenario: Intake module surfaces

- **WHEN** `createTelegramIntake(options)` is called
- **THEN** it SHALL return `handleText`, `handlePhoto`, `handleDocument`, `handleVoice`, `handleAudio`, and `handleTopicDescription`

### Requirement: Intake resolves an active turn once per media update

The intake module SHALL resolve an active turn (`resolveActiveTurn`) once per media update: it SHALL resolve the `ChatLocator` to a session via the `SessionManager`, and return an `ActiveTurn` carrying the locator, the session, the bound `projectDir`, and a scheduling closure that obtains (or creates) the session's `AgentRunner` and schedules work through the per-session promise queue. If the locator is null, intake SHALL drop the update with a debug log and no reply. If no session resolves, intake SHALL reply in DMs (no `topicId`) and silently drop in topics.

#### Scenario: Media update with no locator is dropped

- **WHEN** a media handler receives a message with a null locator
- **THEN** intake SHALL emit a debug log identifying the kind
- **AND** SHALL NOT resolve a session or reply

#### Scenario: No active session in a DM

- **WHEN** a media update resolves no session and the locator has no `topicId`
- **THEN** intake SHALL reply `No active session. Use /new to start one.`
- **AND** SHALL NOT schedule a turn

#### Scenario: No active session in a topic

- **WHEN** a media update resolves no session and the locator has a `topicId`
- **THEN** intake SHALL NOT reply
- **AND** SHALL emit a debug log identifying the kind and the `chatId`/`topicId`

#### Scenario: Active turn carries the bound projectDir

- **WHEN** `resolveActiveTurn` resolves a session for a media update
- **THEN** the `ActiveTurn` SHALL carry the `projectDir` resolved from the `SessionManager` for that locator
- **AND** the scheduling closure SHALL obtain the session's `AgentRunner`, creating it if absent

### Requirement: Intake serializes per-session turns with a stale-runner guard

The intake module SHALL serialize same-session work through a per-session promise queue (`schedulePrompt`). Each scheduled task SHALL receive an `isCurrent()` predicate that returns true only while the runner it captured is still the active runner for that session. Scheduled work SHALL re-check `isCurrent()` before each user-visible side effect (replies, file writes, prompts) and SHALL stop early when the predicate becomes false. When a runner-disposing command replaces a session's runner, pending media work captured against the prior runner SHALL NOT save files, reply, or prompt the replaced runner after its download returns.

#### Scenario: Stale media work does not side-effect after a runner-disposing command

- **GIVEN** an active session whose scheduled media download remains pending
- **WHEN** a runner-disposing command (e.g. `/project`) replaces the session runner before the download finishes
- **THEN** the stale work SHALL NOT save files, reply, or prompt
- **AND** the replaced runner SHALL be disposed

#### Scenario: Media message while streaming serializes

- **GIVEN** an active session whose runner is streaming
- **WHEN** a media message is handled
- **THEN** the download and prompt SHALL be enqueued through the per-session promise queue
- **AND** SHALL NOT start until the current turn settles

### Requirement: Intake applies the steer-vs-queue policy for text

For non-command text on a session whose runner is streaming, the intake module SHALL steer via `AgentRunner.followUp()` rather than enqueue; the message SHALL NOT spawn a new `MessageBuffer` or turn. For idle runners, intake SHALL schedule a fresh turn via `AgentRunner.prompt()`; non-overlapping same-session turns SHALL remain ordered through the per-session queue. If the turn ends between the `isStreaming` check and the `followUp` call, `followUp` SHALL reject with an error containing "not streaming" and intake SHALL fall back to a fresh turn so the message is never silently dropped. For `/queue <text>`, intake SHALL serialize the text via the per-session promise queue as a fresh turn.

#### Scenario: Streaming runner is steered

- **GIVEN** an active session whose runner is streaming
- **WHEN** a non-command text message is handled
- **THEN** intake SHALL call `runner.followUp(preparedText)`
- **AND** SHALL NOT schedule a fresh turn or create a new `MessageBuffer`

#### Scenario: Idle runner gets a fresh turn

- **GIVEN** an active session whose runner is idle
- **WHEN** a non-command text message is handled
- **THEN** intake SHALL schedule a fresh turn via `runner.prompt()`

#### Scenario: Steer race falls back to a fresh turn

- **GIVEN** a runner that is streaming when `isStreaming` is checked
- **WHEN** the turn ends before `runner.followUp()` runs and `followUp` rejects with "not streaming"
- **THEN** intake SHALL fall back to scheduling a fresh turn
- **AND** the message SHALL NOT be silently dropped

#### Scenario: /queue serializes behind a running turn

- **GIVEN** an active session whose runner is streaming
- **WHEN** `/queue do this` is handled
- **THEN** the text SHALL be enqueued through the per-session promise queue
- **AND** SHALL run as a fresh turn only after the current turn and any prior queued work settle

### Requirement: Intake downloads media under a size cap

The intake module SHALL download media via the Telegram file API under a 20 MiB cap. When the `content-length` header or the post-download byte length exceeds the cap, intake SHALL return null (no data) and emit a warn log. Download failures (bad HTTP status, network error) SHALL return null with a warn log rather than throw. Photos SHALL resolve to the largest available size. For images, intake SHALL base64-encode the bytes for an `image` content part.

#### Scenario: Oversize file is rejected

- **WHEN** a downloaded file's `content-length` exceeds 20 MiB
- **THEN** intake SHALL return null and emit a warn log with the file id and size
- **AND** SHALL NOT prompt the runner with the file

#### Scenario: Photo resolves the largest size

- **WHEN** a photo update carries multiple size file ids
- **THEN** intake SHALL download the last (largest) file id only

### Requirement: Intake saves documents, voice, and audio into the project directory

For document, voice, and audio updates on a session with a bound `projectDir`, the intake module SHALL download the file, normalize its name, and write it into the project directory. Names SHALL be reduced with `basename`; document and audio names that normalize to `.` or `..` SHALL be rejected with a reply. Voice files SHALL be named `voice-<timestamp>.<ext>` derived from the mime type (`audio/ogg` → `oga`, else `bin`). After saving, intake SHALL reply with the saved name. Documents and audio SHALL prompt the runner with the caption or saved-file description as before. Voice SHALL prompt the runner with a Groq ASR transcript plus a saved-file note when transcription succeeds. On a session without a `projectDir`, document and audio behavior is unchanged; voice SHALL use Groq ASR when configured and SHALL only reply with a setup/failure message when transcription cannot run.

> **Note:** The document and audio scenarios below are restated canon (existing implemented behavior) and are not modified by this change. Only the voice-specific scenarios are new.

#### Scenario: Voice saved with transcript

- **WHEN** a voice update arrives on a session with a `projectDir`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL write the file as `voice-<timestamp>.oga` for `audio/ogg`
- **AND** SHALL prompt the runner with `[Voice message transcript]`, the transcript, and a note that the file was saved

#### Scenario: Voice without projectDir uses ASR

- **WHEN** a voice update arrives on a session without a `projectDir`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL prompt the runner with `[Voice message transcript]` and the transcript
- **AND** SHALL NOT require project-file saving

### Requirement: Intake applies command side effects to the runner cache

When command dispatch returns `sideEffects`, the intake module SHALL apply them to the shared runner cache and prompt queue: `runner-created` SHALL construct (via `createRunner`) and register a runner for the session; `runner-disposed` SHALL delete the session's pending queue entry, dispose the prior runner if present, and remove it from the cache; `queue-prompt` SHALL obtain the session's runner and schedule a fresh turn with the queued text. Command handling SHALL run before the no-session and prompt paths, so a command that creates a session can be followed immediately by the intake text path on the next update.

#### Scenario: runner-created side effect registers a runner

- **WHEN** a command returns a `runner-created` side effect
- **THEN** intake SHALL construct a runner via `createRunner` and register it under the session id

#### Scenario: runner-disposed side effect disposes the prior runner

- **WHEN** a command returns a `runner-disposed` side effect
- **THEN** intake SHALL delete the session's pending queue entry
- **AND** SHALL dispose the prior runner and remove it from the cache

#### Scenario: queue-prompt side effect schedules a fresh turn

- **WHEN** a command returns a `queue-prompt` side effect
- **THEN** intake SHALL obtain (or create) the session's runner and schedule a fresh turn with the queued text

### Requirement: Voice intake transcribes Telegram voice messages

The intake module SHALL transcribe Telegram voice messages with the configured Groq ASR settings before prompting the agent. A successful transcription SHALL be framed as a text prompt beginning with `[Voice message transcript]`, followed by the transcript text. The voice handler SHALL continue to resolve the active turn once, schedule work through the per-session prompt queue, and apply the stale-runner guard before every user-visible side effect.

#### Scenario: Voice message becomes transcript prompt

- **WHEN** a Telegram voice update arrives for an active session and Groq transcription succeeds
- **THEN** intake SHALL prompt the runner with a fresh turn containing `[Voice message transcript]` and the transcript
- **AND** the prompt SHALL pass through the message `prepare` hook

#### Scenario: Voice message without projectDir still works

- **WHEN** a Telegram voice update arrives for an active session without a bound `projectDir`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL prompt the runner with the transcript
- **AND** SHALL NOT reply with `No project directory is set. Use /project <path> to enable file saving.`

#### Scenario: Voice message with missing mimeType defaults to audio/ogg

- **WHEN** a Telegram voice update arrives with no `voice.mimeType`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL default the mime type to `audio/ogg` and proceed with transcription
- **AND** SHALL NOT reject the message or reply with an error solely due to the missing mime type

#### Scenario: Empty transcript is not prompted

- **WHEN** the ASR module returns `{ ok: true, text: "" }` (successful HTTP response with empty or whitespace-only transcript)
- **THEN** intake SHALL reply that no speech was detected
- **AND** SHALL NOT prompt the runner

#### Scenario: Transcription failure is user-visible

- **WHEN** the voice file downloads successfully but Groq transcription returns `{ ok: false, error }`
- **THEN** intake SHALL reply that the voice message could not be transcribed
- **AND** SHALL NOT prompt the runner with an attachment-only message
- **AND** the reply SHALL NOT include the Groq API key, bearer token, or raw error body

### Requirement: Voice intake preserves project file saving

For sessions with a bound `projectDir`, voice intake SHALL preserve the existing original-file saving behavior and include the saved-file note alongside the transcript. The saved voice file name SHALL continue to be `voice-<timestamp>.<ext>` where `audio/ogg` maps to `oga` and unknown mime types map to `bin`.

#### Scenario: Voice is saved and transcribed with projectDir

- **WHEN** a Telegram voice update arrives on a session with a bound `projectDir`
- **AND** the file downloads and transcription succeeds
- **THEN** intake SHALL write the original voice file into the project directory
- **AND** SHALL reply `Saved <name>.`
- **AND** SHALL prompt the runner with the transcript and a note that `<name>` was saved to the project directory

#### Scenario: Stale voice work does not save or prompt

- **GIVEN** an active session whose scheduled voice download or transcription remains pending
- **WHEN** a runner-disposing command replaces the session runner before the work finishes
- **THEN** the stale work SHALL NOT save the voice file
- **AND** SHALL NOT reply or prompt the replaced runner

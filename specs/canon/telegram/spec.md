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

### Requirement: Intake system replies use tagged formatting

The intake module (`src/tg/intake.ts`) SHALL send all system replies via `sendSystemReply(message, text, tag)` from `src/tg/format.ts` instead of calling `message.reply(text)` directly. The tag SHALL be determined by the surrounding context:

- Download failures, save failures, command crash acks → `"error"`
- Save confirmations, project bound, session created → `"ok"`
- ASR not configured, no project directory set → `"warn"`
- No active session, no speech detected → `"info"`
- Queue acks → `"queued"`

The `recordAssistantReply` calls that log system replies for transcript purposes SHALL continue to log the raw text (without the tag prefix), preserving the existing transcript format.

#### Scenario: Download failure tagged as error

- **WHEN** an image download fails and intake sends a reply
- **THEN** `sendSystemReply` SHALL be called with tag `"error"`
- **AND** the reply SHALL be formatted with `` `[error]` `` prefix
- **AND** `recordAssistantReply` SHALL log the raw text without the tag prefix

#### Scenario: Save confirmation tagged as ok

- **WHEN** a document is saved to the project directory
- **THEN** `sendSystemReply` SHALL be called with tag `"ok"`
- **AND** the reply SHALL be formatted with `` `[ok]` `` prefix

#### Scenario: Queue ack tagged as queued

- **WHEN** a queue-timing command is deferred behind a streaming turn
- **THEN** `sendSystemReply` SHALL be called with tag `"queued"`
- **AND** the reply SHALL be formatted with `` `[queued]` `` prefix

#### Scenario: No active session tagged as info

- **WHEN** `replyNoActiveSession` is called
- **THEN** `sendSystemReply` SHALL be called with tag `"info"`
- **AND** the reply SHALL be formatted with `` `[info]` `` prefix

### Requirement: Command dispatch reply uses tagged formatting

The intake dispatch point SHALL send command results via `sendSystemReply(message, result.reply, result.tag ?? "ok")` when `result.kind === "replied"`. The `result.tag` field on `DispatchResult` provides the semantic category; when absent, `"ok"` SHALL be used as the default.

#### Scenario: Successful command reply

- **WHEN** a dispatched command returns `{ kind: "replied", reply: "Project bound to /path", tag: "ok" }`
- **THEN** the intake SHALL call `sendSystemReply(message, "Project bound to /path", "ok")`

#### Scenario: Failed command reply

- **WHEN** a dispatched command returns `{ kind: "replied", reply: "Failed to save.", tag: "error" }`
- **THEN** the intake SHALL call `sendSystemReply(message, "Failed to save.", "error")`

#### Scenario: Command reply without explicit tag defaults to ok

- **WHEN** a dispatched command returns `{ kind: "replied", reply: "Done.", sideEffects: [] }` (no `tag` field)
- **THEN** the intake SHALL call `sendSystemReply(message, "Done.", "ok")`

### Requirement: Grammy-only commands use tagged formatting

The `/start` and `/ping` commands (registered via `bot.command()` with `grammyHandler`) SHALL send their replies using `systemReply(text, "info")` from `src/tg/format.ts` to format the text, then pass the result to `ctx.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true`. These commands use `ctx.reply` directly (grammy handler path) rather than `TelegramIntakeMessage.reply`, so they do not go through `sendSystemReply`. The tag SHALL be `"info"` for both `/start` (informational welcome) and `/ping` (smoke-test status).

#### Scenario: /start reply

- **WHEN** `/start` is sent
- **THEN** the reply text SHALL be formatted via `systemReply(text, "info")`
- **AND** `ctx.reply` SHALL be called with the formatted text and `{ parse_mode: "MarkdownV2", disable_notification: true }`
- **AND** the reply SHALL render with `` `[info]` `` prefix in Telegram

#### Scenario: /ping reply

- **WHEN** `/ping` is sent
- **THEN** the reply text SHALL be formatted via `systemReply(text, "info")`
- **AND** `ctx.reply` SHALL be called with the formatted text and `{ parse_mode: "MarkdownV2", disable_notification: true }`
- **AND** the reply SHALL render with `` `[info]` `` prefix in Telegram

### Requirement: Allowlist middleware gates guest_message updates by summoner

The allowlist middleware SHALL recognize `guest_message` updates and apply the same `cfg.allowedTgUserIds` membership check used for DMs, keyed on `guest_message.from.id` (the summoner, not the chat). Because grammy does not populate `ctx.chat`/`ctx.from` for `guest_message`, the middleware SHALL read the summoner id directly from `ctx.update.guest_message.from.id`. BotFather's "Restrict bot usage" setting does NOT gate `guest_message`, so this code-level check is load-bearing — without it, any user who knows the bot's username can summon it and burn LLM credits.

#### Scenario: Guest summon from allowed user

- **WHEN** a `guest_message` update arrives
- **AND** `guest_message.from.id` is in `cfg.allowedTgUserIds`
- **THEN** the middleware SHALL call `next()`

#### Scenario: Guest summon from non-allowed user

- **WHEN** a `guest_message` update arrives
- **AND** `guest_message.from.id` is NOT in `cfg.allowedTgUserIds`
- **THEN** the middleware SHALL NOT call `next()`
- **AND** SHALL NOT reply
- **AND** SHALL emit a debug log with the summoner's user id and username

#### Scenario: guest_query_id never enters logs

- **WHEN** the middleware logs anything about a `guest_message` update (allowed or dropped)
- **THEN** the log payload SHALL NOT include the `guest_query_id` field
- **AND** SHALL NOT include a raw JSON dump of the update

#### Scenario: Diagnostic update-shape log is removed

- **WHEN** the change is complete
- **THEN** the temporary diagnostic `update seen` / `GUEST update` log statements added during investigation SHALL be removed from `src/tg/middleware.ts`

### Requirement: Guest message intake runs the agent to completion and replies once

The intake module SHALL provide a `handleGuestMessage(message, text)` method that resolves (or auto-creates) a guest session keyed on the foreign `chat.id`, runs the agent to completion against a non-streaming sink, and sends exactly one reply via the `message.replyVia` callback. The reply SHALL be a single `InlineQueryResultArticle` wrapping `InputTextMessageContent(message_text = <full accumulated assistant text>)`. The handler SHALL NOT use `MessageBuffer`'s streaming-edit path, because `answerGuestQuery` accepts one short-lived single-use call per `guest_query_id`.

The `message` argument SHALL carry `{ chatId: number; replyVia: (result: InlineQueryResult) => Promise<unknown> }`. The `replyVia` callback encapsulates the `answerGuestQuery` call (the `bot.ts` adapter constructs it as `(result) => ctx.answerGuestQuery(result)`, so grammy auto-reads `guest_query_id` from `ctx.guestMessage`). The intake module SHALL NOT extract, name, log, or persist `guest_query_id` — it lives entirely inside the `replyVia` closure and SHALL NOT be written to session state, transcript, logs, or model context.

The `text` argument SHALL already have the `@botname` mention stripped and a sender prefix applied by the `bot.ts` adapter (the intake does not import grammy's `Context`, so it cannot call `stripBotMention`/`prepareUserContent` itself).

If the agent turn produces no text (empty accumulation), the handler SHALL reply with a short fixed fallback message (e.g. `(no response)`) so the summoner sees the bot acknowledged the mention, rather than silence.

If the runner is already streaming when `handleGuestMessage` is invoked, the intake SHALL NOT queue the turn (the `guest_query_id` would expire before a queued turn runs). It SHALL reply immediately via `replyVia` with a short "busy" fallback so the summoner receives an acknowledgment and `guest_query_id` is consumed before it expires.

If `replyVia` itself rejects (e.g. expired `guest_query_id`), the intake SHALL log a warning and swallow the rejection — the summoner sees nothing, but the bot does not crash. This is an inherent limitation of the one-shot API.

#### Scenario: Allowed guest text summon produces one answerGuestQuery reply

- **WHEN** `handleGuestMessage` is called for a guest message from an allowed summoner (already passed by the middleware)
- **AND** the agent turn completes with non-empty text
- **THEN** intake SHALL call `replyVia` exactly once
- **AND** the `result` SHALL be an `InlineQueryResultArticle` whose `InputTextMessageContent.message_text` equals the full accumulated assistant text
- **AND** SHALL NOT call `sendMessage` to the foreign `chat.id`

#### Scenario: Empty agent output sends a fallback reply

- **WHEN** `handleGuestMessage` runs the agent to completion
- **AND** the accumulated assistant text is empty
- **THEN** intake SHALL call `replyVia` exactly once with a short fixed fallback message
- **AND** SHALL NOT omit the reply (the summoner MUST see an acknowledgment)

#### Scenario: Busy runner replies with a fallback instead of queueing

- **WHEN** `handleGuestMessage` is invoked for a guest session whose runner is already streaming
- **THEN** intake SHALL NOT enqueue the turn or call `runner.prompt()`
- **AND** SHALL call `replyVia` once with a short busy fallback (so `guest_query_id` is consumed before expiry)

#### Scenario: replyVia rejection is swallowed

- **WHEN** the `replyVia` callback rejects (e.g. expired `guest_query_id`)
- **THEN** intake SHALL log a warning and swallow the rejection
- **AND** SHALL NOT re-throw or crash

#### Scenario: guest_query_id is not persisted

- **WHEN** a guest turn is handled
- **THEN** the intake code SHALL NOT name or extract `guest_query_id` into a variable
- **AND** the id SHALL NOT be written to `state/sessions/<id>/state.json`
- **AND** SHALL NOT be appended to `state/sessions/<id>/transcript.jsonl`
- **AND** SHALL NOT appear in any log payload

#### Scenario: Guest media message is ignored

- **WHEN** a `guest_message` update arrives carrying media (photo, document, voice, audio) and no `text` field (caption-only media counts as "no text" — captions are out of scope)
- **THEN** intake SHALL drop it with a debug log
- **AND** SHALL NOT call `replyVia` or run the agent

### Requirement: buildBot wires a guest_message grammy handler

`buildBot` (`src/bot.ts`) SHALL register `bot.on("guest_message", handler)` (grammy 1.44.0's native filter query for the Bot API 10.0 `guest_message` update type). The handler SHALL read `ctx.guestMessage`, drop media (no `text`) with a debug log, strip the `@botname` mention and prepend a sender prefix via `prepareUserContent(ctx, text)` (the adapter has `ctx`; the intake does not), and call `await intake.handleGuestMessage({ chatId: ctx.guestMessage.chat.id, replyVia: (result) => ctx.answerGuestQuery(result) }, cleanedText)`. The handler SHALL NOT extract `guest_query_id` into a named variable — grammy's `ctx.answerGuestQuery` reads it internally.

#### Scenario: guest_message routed to intake

- **WHEN** a `guest_message` update passes the allowlist middleware
- **THEN** `buildBot`'s guest handler SHALL read `ctx.guestMessage`
- **AND** SHALL strip the `@botname` mention and prepend a sender prefix via `prepareUserContent`
- **AND** SHALL delegate to `intake.handleGuestMessage({ chatId, replyVia }, cleanedText)`

#### Scenario: Non-guest updates do not hit the guest handler

- **WHEN** a regular `message`, `callback_query`, or other non-guest update arrives
- **THEN** the guest handler SHALL NOT fire

### Requirement: Guest session locator keys on the foreign chat id

For guest turns, the intake module SHALL construct a `ChatLocator` whose `chatId` is `guest_message.chat.id` (the foreign chat the bot is not a member of) and whose `topicId` is `undefined`. The locator SHALL be passed to `SessionManager.resolve(loc, { isGuest: true })` so the session layer auto-creates a guest binding on first summon (mirroring topic/supergroup auto-create, NOT DM-style explicit-create).

#### Scenario: Guest locator is the foreign chat id

- **WHEN** `handleGuestMessage` builds a locator for a guest turn
- **THEN** the locator SHALL be `{ chatId: <guest_message.chat.id> }` with no `topicId`

#### Scenario: Guest session auto-creates on first summon

- **WHEN** `handleGuestMessage` resolves a locator for a foreign chat that has no prior guest binding
- **THEN** `SessionManager.resolve(loc, { isGuest: true })` SHALL create and return a new session
- **AND** SHALL NOT require a prior `/new`

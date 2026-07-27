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

### Requirement: Export telegram module public API

The system SHALL export the public Telegram API from `src/tg/mod.ts`, including `buildAllowlistMiddleware`, `Surface`, `SurfaceId`, `surfaceFromCtx`, the guest-surface normalizer, and the canonical SurfaceId encode/decode functions. `locatorFromCtx` and `ChatLocator` SHALL NOT remain as domain-facing compatibility APIs.

#### Scenario: Module imports from tg

- **WHEN** a module imports from `"./tg/mod.ts"`
- **THEN** it SHALL have access to the surface types, normalizers, codecs, and `buildAllowlistMiddleware`
- **AND** it SHALL NOT need a separate chat-kind flag to use a surface

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

For document, voice, and audio updates on an active Telegram turn, intake SHALL download and save the file under a destination derived exclusively from the Conversation's persisted `ExecutionEnvironment`. A personal environment SHALL use `$GOBLIN_HOME/workspace/attachments/`, created lazily through the sanctioned path helper. A project environment SHALL preserve the existing destination at the canonical project root. Although the personal Conversation's CWD is the workspace root, intake MUST confine raw uploads to its `attachments/` child and MUST NOT write an upload directly over root prompt files or the `skills/` tree.

Intake SHALL reduce supplied names with `basename`, trim them, and reject names that normalize to empty, `.` or `..`. Voice files SHALL retain the generated `voice-<timestamp>.<ext>` convention (`audio/ogg` → `oga`, unknown → `bin`). Saving MUST NOT overwrite an existing file: intake SHALL reserve the original name atomically when available and otherwise append a numeric suffix before the extension until it reserves a free name. The actual reserved path is authoritative for replies and prompts.

After saving, intake SHALL reply with the saved relative name and SHALL prompt the current runner with both any caption/transcript and an explicit saved-file note. A caption MUST NOT be forwarded alone when download, validation, directory creation, or saving fails. Such failure SHALL be user-visible and logged without prompting the runner as though it had received the attachment. Existing 20 MiB download limits, voice ASR behavior, per-Conversation queueing, and stale-runtime checks remain in force; intake MUST recheck runtime currency before filesystem writes, replies, and runner prompts.

#### Scenario: Captioned document in a personal environment

- **GIVEN** a Conversation with the personal execution environment
- **WHEN** the user uploads `notes.md` with caption `please review the ending`
- **THEN** intake SHALL download and save it under `$GOBLIN_HOME/workspace/attachments/notes.md`
- **AND** SHALL prompt the runner with the caption and a note identifying `attachments/notes.md`
- **AND** the runner SHALL be able to read that path relative to its personal CWD

#### Scenario: Uncaptioned document in a personal environment

- **WHEN** the user uploads a valid document without a caption in a personal environment
- **THEN** intake SHALL save it under the personal attachments directory
- **AND** SHALL prompt the runner that the user uploaded the actual reserved path
- **AND** SHALL NOT reply that `/project` is required

#### Scenario: Project document preserves its destination

- **GIVEN** a Conversation whose project execution environment is `/srv/project-a`
- **WHEN** the user uploads `notes.md`
- **THEN** intake SHALL save it as `/srv/project-a/notes.md` when that name is free
- **AND** SHALL identify `notes.md` in the prompt relative to the runner's project CWD

#### Scenario: Existing file is not overwritten

- **GIVEN** `attachments/notes.md` already exists in the personal workdir
- **WHEN** another `notes.md` is uploaded
- **THEN** intake SHALL atomically reserve a collision-free name such as `attachments/notes-2.md`
- **AND** SHALL leave the existing file unchanged
- **AND** the reply and prompt SHALL identify the reserved name rather than the requested name

#### Scenario: Captioned download failure is not disguised as success

- **WHEN** a captioned document is oversized or cannot be downloaded or saved
- **THEN** intake SHALL tell the user that the attachment could not be retained
- **AND** SHALL log the failure with non-secret file and destination context
- **AND** SHALL NOT prompt the runner with the caption alone

#### Scenario: Unsafe filename is rejected

- **WHEN** a document or audio filename normalizes to empty, `.` or `..`
- **THEN** intake SHALL reply that the filename is unsafe
- **AND** SHALL NOT write a file or prompt the runner with an attachment note

#### Scenario: Voice in a personal environment is saved and transcribed

- **GIVEN** Groq ASR is configured
- **WHEN** a voice update arrives for a personal Conversation and transcription succeeds
- **THEN** intake SHALL save the original under the personal attachments directory
- **AND** SHALL prompt the runner with `[Voice message transcript]`, the transcript, and the saved relative path

#### Scenario: Audio in a personal environment is saved

- **WHEN** an audio update with a valid filename arrives for a personal Conversation
- **THEN** intake SHALL save it under the personal attachments directory
- **AND** SHALL prompt the runner with any caption/metadata and the saved relative path

#### Scenario: Workspace prompt files cannot be replaced by uploads

- **WHEN** a personal user uploads a file named `SOUL.md`, `AGENTS.md`, or any other name
- **THEN** intake SHALL confine it to `$GOBLIN_HOME/workspace/attachments/`
- **AND** SHALL NOT replace `$GOBLIN_HOME/workspace/SOUL.md`, `$GOBLIN_HOME/workspace/AGENTS.md`, or anything under `$GOBLIN_HOME/workspace/.agents/skills/`

#### Scenario: Stale attachment work has no effects

- **GIVEN** attachment processing remains pending
- **WHEN** the Conversation runtime is invalidated before its filesystem write
- **THEN** intake SHALL NOT save, reply, or prompt from the stale work

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

`buildBot` SHALL construct one text coalescer per bot. The coalescer SHALL key buffers by `(SurfaceId, fromUserId)`, using the `SurfaceId` produced from the intake message's complete surface. It SHALL NOT build keys from optional topic IDs or chat-ID sign.

#### Scenario: Fragments from different senders stay separate

- **WHEN** different senders post fragments on the same surface
- **THEN** their buffers SHALL remain separate

#### Scenario: Fragments on different surfaces stay separate

- **WHEN** fragments arrive on different topic containers, topics, DMs, supergroups, or guest surfaces
- **THEN** they SHALL be evaluated under different canonical surface keys

### Requirement: MessageBuffer records Telegram API call metrics

The `MessageBuffer` class in `src/tg/buffer.ts` SHALL accept an optional `metrics` `MetricsStore` in `MessageBufferOptions`. When `metrics` is present, every `sendMessage` and `editMessageText` call made by `MessageBuffer` (status placeholder, status edits, response sends, response edits, rollover sends/edits, plain-text retry sends/edits, and the summary `sendMessage` after a file escape) SHALL record a `telegram` `MetricsEvent` describing the call.

- `op` SHALL be `"sendMessage"` for `sendMessage` calls and `"editMessageText"` for `editMessageText` calls.
- `channel` SHALL be `"status"` for status-line operations and `"response"` for response-bubble operations.
- `outcome` SHALL be:
  - `"success"` when the API call resolves without throwing;
  - `"rate_limited"` when Telegram returns `error_code: 429`;
  - `"topic_not_found"` when the 400 description matches the topic/thread-not-found pattern;
  - `"message_gone"` when the 400 description matches the message-not-found/cannot-be-edited pattern;
  - `"message_not_modified"` when the 400 description matches "message is not modified";
  - `"error"` for all other failures.
- Non-success outcomes SHALL include `errorCode` and `errorDescription` in the event.

The `topic_not_found` outcome is recorded through the `telegram` event above; `readMetricsSummary` derives `topicNotFound` from `topic_not_found` events (and can still combine any separately-recorded `telegram_topic_not_found_total` counter values).

#### Scenario: Status placeholder send succeeds

- **WHEN** `flushStatus` calls `sendMessage` and the API resolves
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "status"`, `outcome: "success"` SHALL be appended to `metrics.jsonl`

#### Scenario: Response edit is rate-limited

- **WHEN** `flushResponse` calls `editMessageText` and Telegram returns 429 with `retry_after`
- **THEN** a `telegram` event with `op: "editMessageText"`, `channel: "response"`, `outcome: "rate_limited"` and `retryAfterSec` SHALL be recorded
- **AND** the buffer's `lastResponseEditTime` SHALL be advanced by the retry interval

#### Scenario: Topic not found during response edit

- **WHEN** `flushResponse` calls `editMessageText` and Telegram returns a 400 matching topic not found
- **THEN** a `telegram` event with `op: "editMessageText"`, `channel: "response"`, `outcome: "topic_not_found"` SHALL be recorded
- **AND** `readMetricsSummary` for the session SHALL report `topicNotFound: 1`

#### Scenario: Response send hits a MarkdownV2 parse error and retries as plain text

- **WHEN** `flushResponse` calls `sendMessage` with `parse_mode: "MarkdownV2"` and Telegram returns a 400 parse error
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "response"`, `outcome: "error"`, `errorCode: 400`, and `errorDescription` containing parse SHALL be recorded
- **AND** the buffer SHALL retry the same text as plain text
- **AND** the retry `sendMessage` SHALL record a `success` event when it resolves

### Requirement: MessageBuffer records response and status throttling

When `MessageBuffer.flushResponse` or `MessageBuffer.flushStatus` short-circuits because the elapsed time since the last edit is less than the configured throttle window, the buffer SHALL record a `telegram` `MetricsEvent` with `op: null`, `channel` set to `"status"` or `"response"`, `outcome: "throttled"`, and top-level `elapsedMs` and `throttleMs` fields.

#### Scenario: Response flush is throttled

- **WHEN** `flushResponse` is called while `now - lastResponseEditTime < responseThrottleMs`
- **THEN** a `telegram` event with `op: null`, `channel: "response"`, `outcome: "throttled"`, `elapsedMs`, and `throttleMs` SHALL be recorded
- **AND** no `sendMessage` or `editMessageText` call SHALL be made for that flush

#### Scenario: Status flush is throttled

- **WHEN** `flushStatus` is called while `now - lastEditTime < statusThrottleMs`
- **THEN** a `telegram` event with `op: null`, `channel: "status"`, `outcome: "throttled"`, `elapsedMs`, and `throttleMs` SHALL be recorded

### Requirement: MessageBuffer receives a session-scoped MetricsStore

`MessageBufferOptions` SHALL include an optional `metrics` field of type `MetricsStore`. The `createMessageBuffer` factory in `src/tg/intake.ts` SHALL create a `MetricsStore` scoped to the `SessionState` resolved for the `ChatLocator` and pass it to the `MessageBuffer` constructor. The `TurnDispatcher` SHALL pass the current `SessionState` to `createMessageBuffer` when it creates a turn sink so the factory can build the `MetricsStore` without re-resolving the session.

#### Scenario: Active session MessageBuffer has a MetricsStore

- **WHEN** `createMessageBuffer` is called for a session with id `abc123`
- **THEN** the returned `MessageBuffer` SHALL have `metrics` scoped to `state/sessions/abc123/metrics.jsonl`
- **AND** all Telegram API calls from that buffer SHALL append to that session's `metrics.jsonl`

#### Scenario: No session yields no MetricsStore

- **WHEN** `createMessageBuffer` is called with no `SessionState` and no session can be resolved for the locator
- **THEN** the returned `MessageBuffer` SHALL have no `metrics`
- **AND** it SHALL operate without recording telemetry

### Requirement: System replies record sendMessage metrics

`src/bot.ts` SHALL wrap `ctx.reply` in `TelegramIntakeMessage.reply` with a closure that records a `telegram` `MetricsEvent` for every `sendMessage` attempt (including the plain-text retry inside `sendSystemReply`). Each system-reply `sendMessage` attempt SHALL record `op: "sendMessage"`, `channel: "system"`, and `outcome` (`success` or the failure outcome). The wrapper SHALL NOT throw or crash if the `MetricsStore` is unavailable or recording fails.

#### Scenario: sendSystemReply succeeds

- **WHEN** `sendSystemReply` calls `message.reply` with Markdown and `ctx.reply` resolves
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "system"`, `outcome: "success"` SHALL be recorded

#### Scenario: sendSystemReply parse error and retry

- **WHEN** `sendSystemReply` calls `message.reply` with Markdown and `ctx.reply` throws a 400 parse error
- **THEN** a `telegram` event with `op: "sendMessage"`, `channel: "system"`, `outcome: "error"`, `errorCode: 400`, and `errorDescription` containing parse SHALL be recorded
- **AND** the plain-text retry `sendMessage` SHALL record a `success` event when it resolves

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

Telegram send/edit/media/draft adapters SHALL derive normal delivery options from a complete `Surface` using `deliveryOpts(surface)`. Telegram chat-action adapters SHALL derive `sendChatAction` options from a complete `Surface` using `chatActionDeliveryOpts(surface)`. The two derivations differ only for a forum General topic (`container === "supergroup"` and `topicId === 1`): normal sends, edits, media, and drafts to that surface SHALL target the surface `chatId` and SHALL NOT set `message_thread_id`; chat actions to that surface SHALL set `message_thread_id = 1` so the typing indicator appears in the General topic. For all other private and forum-supergroup topics, both normal and chat-action adapters SHALL set `message_thread_id = topicId`. Direct-messages topics SHALL use `direct_messages_topic_id = topicId` for both adapters. Topicless DM and supergroup surfaces SHALL use neither topic parameter. Guest surfaces SHALL use their encapsulated `answerGuestQuery` callback rather than normal chat send methods. Domain modules SHALL NOT construct either topic parameter.

#### Scenario: Ordinary forum topic delivery

- **WHEN** the Telegram adapter sends, edits, or replies to a forum topic whose container is `supergroup` and whose `topicId` is not `1`
- **THEN** it SHALL target the surface `chatId` with `message_thread_id = topicId`
- **AND** it SHALL NOT set `direct_messages_topic_id`

#### Scenario: Private topic delivery

- **WHEN** the Telegram adapter sends, edits, or replies to a private-chat topic (`container === "private"`)
- **THEN** it SHALL target the surface `chatId` with `message_thread_id = topicId`
- **AND** it SHALL NOT set `direct_messages_topic_id`

#### Scenario: Supergroup General topic normal send

- **WHEN** `deliveryOpts(surface)` is used for a `supergroup` topic surface whose `topicId` is `1`
- **THEN** it SHALL target the surface `chatId` and SHALL NOT set `message_thread_id`
- **AND** it SHALL NOT set `direct_messages_topic_id`

#### Scenario: Supergroup General topic chat action

- **WHEN** `chatActionDeliveryOpts(surface)` is used for a `supergroup` topic surface whose `topicId` is `1`
- **THEN** it SHALL target the surface `chatId` with `message_thread_id = 1`
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

### Requirement: MessageBuffer delivers out-of-band notices

`MessageBuffer` SHALL expose `sendNotice(text: string): Promise<void>` for bounded, non-blocking informational notices such as a prompt-file write summary. It SHALL deliver the text by reusing `sendSystemReply` with the `"info"` tag and silent delivery (`disable_notification: true`), sharing formatting and plain-text fallback with other system replies. It SHALL record a `telegram` metrics event in the `system` channel, reusing the existing `classifyTelegramError` path so success and Telegram-side failures are reported consistently with other sends. A Telegram-side failure SHALL propagate to the caller, which treats notice delivery as best-effort.

#### Scenario: Notice is sent as a silent info-tagged reply

- **WHEN** `MessageBuffer.sendNotice("Modified prompt file `SOUL.md`: wrote 12 lines (340 chars)")` is called
- **THEN** `sendSystemReply` SHALL be invoked with the text and tag `"info"`
- **AND** the message SHALL be sent with `disable_notification: true`
- **AND** a `telegram` metrics event with `channel: "system"` and `outcome: "success"` SHALL be recorded

#### Scenario: Telegram-side failure is classified and rethrown

- **WHEN** `bot.api.sendMessage` rejects during a notice
- **THEN** the error SHALL be classified via `classifyTelegramError`
- **AND** a `telegram` metrics event with `channel: "system"` and the classified outcome SHALL be recorded
- **AND** the error SHALL propagate to the caller

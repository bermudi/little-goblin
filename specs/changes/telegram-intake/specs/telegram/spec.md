# telegram

## ADDED Requirements

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

For document, voice, and audio updates on a session with a bound `projectDir`, the intake module SHALL download the file, normalize its name, and write it into the project directory. Names SHALL be reduced with `basename`; document and audio names that normalize to `.` or `..` SHALL be rejected with a reply. Voice files SHALL be named `voice-<timestamp>.<ext>` derived from the mime type (`audio/ogg` → `oga`, else `bin`). Audio without a file name SHALL derive one from `performer`/`title` (falling back to `audio-<timestamp>.mp3`). After saving, intake SHALL reply with the saved name and prompt the runner with a description of the saved file. On a session without a `projectDir`, intake SHALL reply `No project directory is set. Use /project <path> to enable file saving.` unless the update carries a caption, in which case the caption SHALL be prompted as-is.

#### Scenario: Document saved with caption

- **WHEN** a document update arrives on a session with a `projectDir` and a caption
- **THEN** intake SHALL write the file under its normalized name
- **AND** SHALL reply `Saved <name>.`
- **AND** SHALL prompt the runner with the caption followed by a note that the file was saved

#### Scenario: Voice saved with a generated name

- **WHEN** a voice update arrives on a session with a `projectDir`
- **THEN** intake SHALL write the file as `voice-<timestamp>.oga` (for `audio/ogg`)
- **AND** SHALL prompt the runner with a description of the saved voice message

#### Scenario: Audio without a file name derives one

- **WHEN** an audio update arrives with no `file_name` but a performer and title
- **THEN** intake SHALL derive `<performer> - <title>.mp3`

#### Scenario: Unsafe document name is rejected

- **WHEN** a document name normalizes to `.` or `..`
- **THEN** intake SHALL reply `Rejected: unsafe filename.`
- **AND** SHALL NOT write a file

#### Scenario: Document without projectDir but with caption

- **WHEN** a document update arrives on a session with no `projectDir` and a caption
- **THEN** intake SHALL prompt the runner with the caption
- **AND** SHALL NOT reply with the no-`projectDir` message

#### Scenario: Media without projectDir or caption

- **WHEN** a document or audio update arrives on a session with no `projectDir` and no caption
- **THEN** intake SHALL reply `No project directory is set. Use /project <path> to enable file saving.`
- **AND** SHALL NOT prompt the runner

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

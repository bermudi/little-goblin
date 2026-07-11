# sessions

## Requirements

### Requirement: Generate short session IDs

The system SHALL generate 10-character hexadecimal session IDs from UUID v4, providing ~1.1 trillion combinations.

#### Scenario: New session created

- **WHEN** `createForChat()` is called
- **THEN** the resulting session SHALL have an `id` of exactly 10 lowercase hex characters

### Requirement: Resolve DM sessions only when explicitly bound

The system SHALL return `null` when resolving a DM locator that has no active binding (user must explicitly create with `/new`).

#### Scenario: DM with no binding

- **WHEN** `resolve()` is called with a DM locator (no topicId)
- **AND** no binding exists for that chatId
- **THEN** it SHALL return `null`

#### Scenario: DM with active binding

- **WHEN** `resolve()` is called with a DM locator that has a binding
- **THEN** it SHALL return the `SessionState` from the bound session

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

### Requirement: Handle stale bindings for DMs

The system SHALL detect and clear stale DM bindings (where state.json is missing) during resolution.

#### Scenario: Stale DM binding

- **WHEN** `resolve()` is called for a DM with a binding
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, remove the binding from `state/bindings.json`, and return `null`

### Requirement: Handle stale bindings for topics by recreating

The system SHALL auto-recreate topic sessions when the bound session is stale. The recreated session SHALL NOT include a `projectDir` field in `state.json`.

#### Scenario: Stale topic binding

- **WHEN** `resolve()` is called for a topic with a binding
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, create a new session, update the binding, and return the new state
- **AND** the new session's `state.json` SHALL NOT contain `projectDir`

### Requirement: Persist session state atomically

The system SHALL write session state using atomic write (tmp file + rename) to prevent corruption. State SHALL be loaded and saved through the JSON state-file module (`loadJsonFile`/`saveJsonFile`); the module owns the read recipe and the atomic-write wrapper. The default for a missing `state.json` SHALL be `null` (session treated as missing), preserving existing behavior.

#### Scenario: Session state saved

- **WHEN** `saveState()` is called
- **THEN** it SHALL write to a temp file named `.state-<id>.tmp` in the session directory
- **AND** rename the temp file to `state.json` atomically

#### Scenario: Session state loaded through the module

- **WHEN** `loadState()` is called and `state.json` exists
- **THEN** it SHALL return the parsed state via `loadJsonFile`
- **AND** when `state.json` does not exist, it SHALL return `null` (the caller-supplied default)

### Requirement: Persist bindings atomically

The system SHALL write `state/bindings.json` (session bindings) using atomic write with unique temp names. Bindings SHALL be loaded and saved through the JSON state-file module; the default for a missing or malformed `bindings.json` SHALL be the empty bindings structure.

#### Scenario: Bindings saved

- **WHEN** `saveBindings()` is called
- **THEN** it SHALL write to a temp file with name `.bindings.<random8chars>.tmp` in `state/`
- **AND** rename the temp file to `state/bindings.json` atomically

#### Scenario: Bindings loaded through the module

- **WHEN** `loadBindings()` is called and `bindings.json` is missing or malformed
- **THEN** it SHALL return the default empty bindings structure via `loadJsonFile`

### Requirement: Create session filesystem layout

The system SHALL create the complete filesystem structure when creating a session.

#### Scenario: Session created

- **WHEN** `createForChat()` is called
- **THEN** it SHALL create: `state/sessions/<id>/` directory, `state/sessions/<id>/workdir/` directory, `state/sessions/<id>/events.jsonl` (empty), `state/sessions/<id>/transcript.jsonl` (empty), and `state/sessions/<id>/state.json`

### Requirement: Write transcript entries on message completion

The system SHALL append final message entries to `transcript.jsonl` when pi emits `message_end` events. All writes and all reads of `transcript.jsonl` SHALL cross a single transcript module that owns the `TranscriptEntry` type, the writer, and the reader. No module other than the transcript module SHALL `JSON.parse` transcript lines or construct `TranscriptEntry` values directly.

The transcript module SHALL be the sole producer and the sole typing authority for transcript entries: `events.ts` SHALL write through the module's writer, and the memory reflection pipeline SHALL read through the module's reader. The two consumers SHALL NOT maintain private transcript entry types; both SHALL reference the module's exported `TranscriptEntry` type.

#### Scenario: Message end event received

- **WHEN** a `message_end` event is received from pi
- **THEN** the system SHALL extract the `message` field
- **AND** normalize it into a transcript entry (typed by the transcript module) with `ts`, `role`, `timestamp`, and `content`
- **AND** for assistant messages, include `api`, `provider`, `model`, `stopReason`, and `errorMessage` if present
- **AND** for tool result messages, include `toolCallId`, `toolName`, and `isError`
- **AND** drop noisy/sensitive payloads: image base64 data (keep `mimeType`), provider signatures (`textSignature`, `thinkingSignature`), and tool result `details`
- **AND** append the entry as a single JSONL line to `transcript.jsonl` via the transcript module's writer

#### Scenario: Non-message_end events received

- **WHEN** an event type other than `message_end` is received
- **THEN** the system SHALL NOT write to `transcript.jsonl`

#### Scenario: Reader and writer share one type

- **WHEN** the reflection pipeline reads a transcript entry written by `events.ts`
- **THEN** the reader SHALL parse the line into the same `TranscriptEntry` type the writer used
- **AND** SHALL NOT use a private re-declared subset type

#### Scenario: Round-trip preserves all fields the writer can produce

- **GIVEN** the writer can produce assistant entries with optional `api`/`provider`/`model`/`stopReason`/`errorMessage`, tool-result entries with `toolCallId`/`toolName`/`isError`, and content blocks including text, tool calls, and images (mimeType only)
- **WHEN** any such entry is written and then read back through the transcript module
- **THEN** the reader SHALL return a value whose fields match the writer's input
- **AND** SHALL NOT silently drop text that the writer recorded

### Requirement: Support session rebinding for DMs

The system SHALL allow creating new DM sessions even when one exists (orphaning the old session).

#### Scenario: DM session rebound

- **WHEN** `createForChat()` is called for a DM that already has a session
- **THEN** it SHALL create a new session with a new ID
- **AND** update the binding to point to the new session
- **AND** leave the old session directory intact (orphaned)

### Requirement: List all sessions

The system SHALL provide a method to list all sessions sorted by creation time.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found in the sessions directory
- **AND** results SHALL be sorted by `createdAt` ascending (oldest first)
- **AND** orphaned sessions (no binding) SHALL be included

### Requirement: Return empty array for missing sessions directory

The system SHALL handle ENOENT when listing sessions gracefully.

#### Scenario: List with no sessions dir

- **WHEN** `list()` is called and the sessions directory does not exist
- **THEN** it SHALL return an empty array `[]` without throwing

### Requirement: Export session types and manager

The system SHALL export the public API from `src/sessions/mod.ts`.

#### Scenario: Module imports from sessions/

- **WHEN** a module imports from `"./sessions/mod.ts"`
- **THEN** it SHALL have access to `SessionManager` class and types `ChatLocator`, `SessionState`

### Requirement: Persist session titles

The session manager SHALL allow setting or clearing `SessionState.title` for an existing session and persist the updated state atomically.

#### Scenario: Title set

- **WHEN** `setTitle(sessionId, "memory refactor")` is called for an existing session
- **THEN** `state/sessions/<id>/state.json` SHALL contain `"title": "memory refactor"`
- **AND** resolving that session SHALL return the updated title

#### Scenario: Missing session title update

- **WHEN** `setTitle()` is called for a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: Bind existing sessions to chat surfaces

The session manager SHALL allow binding an existing resumable session to a DM, supergroup, or forum topic locator without creating a new session and without deleting or archiving the session previously bound to that surface.

#### Scenario: Bind existing session to DM

- **WHEN** `bindExistingToChat(sessionId, { chatId })` is called for an existing session
- **THEN** the DM binding for `chatId` SHALL point to `sessionId`
- **AND** the previously bound session directory SHALL remain intact

#### Scenario: Bind existing session to topic

- **WHEN** `bindExistingToChat(sessionId, { chatId, topicId })` is called for an existing session
- **THEN** the topic binding for `(chatId, topicId)` SHALL point to `sessionId`

#### Scenario: Bind missing session

- **WHEN** `bindExistingToChat()` is called for a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: Session rebinding leaves old session resumable

When creating a new session for a DM that already has one, the old session SHALL remain under `state/sessions/<old-id>/` as an unbound resumable session.

#### Scenario: DM session rebound

- **WHEN** `createForChat()` is called for a DM that already has a session
- **THEN** it SHALL create a new session with a new ID
- **AND** update the binding to point to the new session
- **AND** leave the old session directory intact as a resumable unbound session

### Requirement: List resumable sessions excludes archive

The session list SHALL include unbound sessions and exclude archived sessions under `state/sessions/archive/<id>/`.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found directly under the `state/sessions/` directory
- **AND** unbound sessions SHALL be included
- **AND** archived sessions SHALL be excluded

### Requirement: Topic settings file

The system SHALL maintain a `state/topic-settings.json` file under `$GOBLIN_HOME` that stores per-chat-surface settings including `projectDir`. Topic settings SHALL be loaded and saved through the JSON state-file module; the default for a missing or malformed file SHALL be the empty settings structure. The locator-keyed slot logic (which settings record a given `(chatId, topicId)` resolves to) SHALL remain in `topic-settings.ts` — it is not part of the read/write recipe.

Note: prior to this change, `loadTopicSettings` swallowed all read errors. After this change it matches the shared module policy: `ENOENT` and `SyntaxError` return the default; all other errors propagate (fail loud). This is a deliberate behavior change.

#### Scenario: Load topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` exists
- **THEN** it SHALL return the parsed settings via `loadJsonFile`

#### Scenario: Default topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` does not exist
- **THEN** it SHALL return an empty default structure (the caller-supplied default)

#### Scenario: Malformed topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` exists but contains invalid JSON
- **THEN** it SHALL return an empty default structure via `loadJsonFile`
- **AND** it SHOULD log a warning

#### Scenario: Non-JSON errors propagate (behavior change)

- **WHEN** `loadTopicSettings()` is called
- **AND** `readFileSync` throws a non-`ENOENT`, non-`SyntaxError` error (e.g. permission denied)
- **THEN** the error SHALL propagate to the caller (fail loud)
- **AND** SHALL NOT be swallowed into the default
- **NOTE** prior to this change, `topic-settings.ts` swallowed all errors; this scenario pins the new fail-loud behavior

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

`state/topic-settings.json` SHALL be written using atomic write (tmp file + rename).

#### Scenario: Save topic settings

- **WHEN** `saveTopicSettings()` is called
- **THEN** it SHALL write to a temp file with a random suffix in `state/`
- **AND** rename it to `state/topic-settings.json` atomically

### Requirement: Persist scheduled turn definitions

The system SHALL persist scheduled turn definitions in a JSON file under `GOBLIN_HOME` using atomic write semantics. Each schedule SHALL contain an id, session id, captured `ChatLocator`, kind, enabled state, next run timestamp, optional recurrence interval, creation timestamp, and optional last-run metadata. One-shot and recurring schedules SHALL additionally store user-supplied prompt text; heartbeat schedules SHALL store no user prompt text (the heartbeat prompt is a system-owned constant defined in the scheduler loop). The schedule store MUST NOT live inside an individual session directory, because schedules need to be discoverable at startup before any runner is created.

#### Scenario: One-shot schedule persisted

- **WHEN** a user creates a one-shot schedule for an active session
- **THEN** the schedule store SHALL contain a schedule with that session id, locator, prompt text, `kind = "once"`, `enabled = true`, and `nextRunAt`
- **AND** the file write SHALL use the project's atomic write pattern

#### Scenario: Recurring schedule persisted

- **WHEN** a user creates a recurring schedule with interval 2 hours
- **THEN** the schedule store SHALL contain `kind = "recurring"` and `intervalMs = 7200000`

#### Scenario: Missing schedule store

- **WHEN** the scheduler starts and the schedule store file does not exist
- **THEN** it SHALL treat the store as empty without throwing

#### Scenario: Malformed schedule store

- **WHEN** the schedule store file contains invalid JSON
- **THEN** startup SHALL log a warning and treat the store as empty

### Requirement: Scheduled turns stay bound to their captured session surface

A scheduled turn SHALL run only when the captured session id is still the active binding for the captured `ChatLocator`. Binding validation SHALL use a non-mutating peek (`SessionManager.peekBinding(loc)`) that reads bindings and state without auto-creating sessions. The scheduler MUST NOT use `SessionManager.resolve(loc)` for binding validation because it auto-creates sessions for topic and supergroup locators. If the session was archived, rebound, or otherwise no longer matches the locator, the scheduler SHALL disable the schedule and SHALL NOT dispatch the prompt.

#### Scenario: Session still bound

- **WHEN** a due schedule's captured locator still resolves to the captured session id via `peekBinding`
- **THEN** the scheduler SHALL dispatch the scheduled prompt as a fresh turn for that session

#### Scenario: Session no longer bound

- **WHEN** a due schedule's captured locator resolves to a different session id or no session via `peekBinding`
- **THEN** the scheduler SHALL disable the schedule
- **AND** SHALL record a last-run status with `outcome: "binding-mismatch"`
- **AND** SHALL NOT prompt the old session

#### Scenario: Archived session skipped

- **WHEN** a due schedule's captured locator resolves to no session via `peekBinding` because the session was archived (binding cleared by `archive()`)
- **THEN** the scheduler SHALL disable the schedule
- **AND** SHALL record a last-run status with `outcome: "archived"`
- **AND** SHALL NOT recreate or resume the archived session
- **AND** SHALL NOT call `SessionManager.resolve()` which would auto-create a new session for topic/supergroup locators

### Requirement: Heartbeat schedule is explicit and session-scoped

The system SHALL represent heartbeat as an explicit session-scoped schedule kind. Heartbeat SHALL be disabled by default. Enabling heartbeat without an interval SHALL use a 30-minute interval. The heartbeat prompt SHALL be generated by the system, prefixed with the literal marker `[heartbeat]`, and SHALL ask Goblin whether there is anything useful, timely, or important to say for the current session; it MUST NOT claim a user asked a new question. The `[heartbeat]` prefix SHALL make the prompt distinguishable from user-authored text at the agent layer and in transcripts.

At dispatch time, the heartbeat prompt body SHALL be sourced from `$GOBLIN_HOME/workspace/HEARTBEAT.md` if that file exists. If the file is absent, the system SHALL fall back to the system-owned constant prompt defined in the scheduler loop. The heartbeat schedule record SHALL store no user prompt text; the prompt is resolved from the file (or constant) at dispatch time, not captured at schedule creation time. When the file is present, the system SHALL prepend `[heartbeat] ` to the file's content. When the file is absent, the system SHALL use the system-owned constant as-is, which already includes the `[heartbeat]` prefix. In both cases, the dispatched prompt SHALL begin with exactly one `[heartbeat]` marker.

When the file is present and non-empty, trailing whitespace SHALL be stripped from the file content before prepending the marker; leading whitespace SHALL be preserved (the user may intend an indented first line as part of the body). A file that contains only whitespace SHALL be treated as empty and the system SHALL fall back to the constant.

#### Scenario: Heartbeat default disabled

- **WHEN** a new session is created
- **THEN** no heartbeat schedule SHALL exist for that session

#### Scenario: Heartbeat enabled with default interval

- **WHEN** the user enables heartbeat without specifying an interval
- **THEN** the schedule store SHALL contain an enabled heartbeat schedule for that session with `intervalMs = 1800000`

#### Scenario: Heartbeat due turn with HEARTBEAT.md present

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** `$GOBLIN_HOME/workspace/HEARTBEAT.md` exists with content
- **THEN** the scheduler SHALL dispatch a fresh turn with `[heartbeat]` prepended to the file's content (trailing whitespace stripped, leading whitespace preserved)
- **AND** the prompt SHALL be distinguishable from user-authored text

#### Scenario: Heartbeat due turn with HEARTBEAT.md absent

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** `$GOBLIN_HOME/workspace/HEARTBEAT.md` does not exist
- **THEN** the scheduler SHALL dispatch a fresh turn with the system-owned constant prompt
- **AND** the prompt SHALL begin with exactly one `[heartbeat]` marker (the constant already includes the prefix; no additional prefix is prepended)

#### Scenario: HEARTBEAT.md edits take effect on next heartbeat

- **GIVEN** heartbeat is enabled and a heartbeat turn has run with the current HEARTBEAT.md content
- **WHEN** the user edits `$GOBLIN_HOME/workspace/HEARTBEAT.md`
- **AND** the next heartbeat schedule becomes due
- **THEN** the scheduler SHALL read the file at dispatch time and use the updated content
- **AND** no restart SHALL be required

#### Scenario: HEARTBEAT.md is empty or whitespace-only

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** `$GOBLIN_HOME/workspace/HEARTBEAT.md` exists but is empty or contains only whitespace
- **THEN** the scheduler SHALL fall back to the system-owned constant prompt
- **AND** the dispatched prompt SHALL begin with exactly one `[heartbeat]` marker

#### Scenario: HEARTBEAT.md read error other than ENOENT

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** `$GOBLIN_HOME/workspace/HEARTBEAT.md` exists but cannot be read for a reason other than `ENOENT`
- **THEN** the scheduler SHALL propagate the error rather than fall back to the constant
- **AND** the heartbeat turn SHALL NOT be dispatched
- **AND** the error SHALL be isolated to this schedule: other due schedules in the same tick SHALL still be processed (the failing schedule does not claim, so it remains due; a persistent read error retries on every tick until the operator fixes the file, but does not starve unrelated schedules)

#### Scenario: Failing schedule does not starve other due schedules

- **GIVEN** two schedules are due in the same tick
- **AND** the first schedule's processing throws (e.g. a heartbeat whose `HEARTBEAT.md` cannot be read for a non-ENOENT reason, or a synchronous dispatcher bug)
- **WHEN** the scheduler runs the tick
- **THEN** the scheduler SHALL log the failure and continue processing the remaining due schedules in the same tick
- **AND** the failed schedule's error SHALL NOT abort the tick loop or skip later due schedules

### Requirement: Guest session bindings keyed on foreign chat id

The session manager SHALL persist guest session bindings in a separate `guest` map in `state/bindings.json`, keyed by the foreign `chat.id` (the chat the bot was summoned in but is not a member of). The guest map SHALL be distinct from the existing `dm`, `topics`, and `supergroups` maps so guest auto-create does not collide with normal DM/supergroup binding semantics for the same numeric chat id.

The `BindingsFile` interface SHALL add `guest?: Record<string, string>` (chatId → sessionId), matching the existing `dm` and `supergroups` maps' string-keyed shape. Lookups SHALL use `String(loc.chatId)` as the key, mirroring the existing branches. Existing consumers that ignore unknown binding keys SHALL continue to work unchanged; consumers that read bindings SHALL treat the `guest` map as a new surface.

#### Scenario: BindingsFile includes a guest map

- **WHEN** the bindings file is read or written
- **THEN** its type SHALL permit a `guest: Record<number, string>` field
- **AND** the field SHALL be optional (existing bindings files without it SHALL parse)

#### Scenario: Guest binding is separate from DM binding for the same chat id

- **WHEN** a guest session is bound to foreign chat id `C`
- **AND** a normal DM session is later bound to the same numeric id `C` (or vice versa)
- **THEN** the two bindings SHALL coexist without overwriting each other
- **AND** `resolve(loc, { isGuest: true })` SHALL return the guest binding
- **AND** `resolve(loc)` (no `isGuest`) SHALL return the DM binding

### Requirement: Auto-create guest sessions on first resolve

The session manager SHALL accept an `isGuest: boolean` option on `resolve()` and `createForChat()`. When `resolve()` is called with `{ isGuest: true }` for a locator with no existing guest binding, it SHALL create a new session and bind it in the `guest` map — mirroring the topic/supergroup auto-create behavior, NOT the DM-style explicit-create (which returns `null` when unbound). Stale guest bindings (state.json missing) SHALL auto-heal by recreating, mirroring topic stale-binding behavior.

#### Scenario: First guest resolve creates a session

- **WHEN** `resolve(loc, { isGuest: true })` is called for a chatId with no guest binding
- **THEN** it SHALL create a new session
- **AND** SHALL write the binding to the `guest` map
- **AND** SHALL return the new session state

#### Scenario: Subsequent guest resolve returns the bound session

- **WHEN** `resolve(loc, { isGuest: true })` is called for a chatId with an existing guest binding
- **THEN** it SHALL return the existing session state

#### Scenario: Stale guest binding auto-heals

- **WHEN** `resolve(loc, { isGuest: true })` is called
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, create a new session, update the guest binding, and return the new state

#### Scenario: isGuest defaults to false

- **WHEN** `resolve(loc)` is called without the `isGuest` option
- **THEN** it SHALL behave exactly as before (DM/topic/supergroup routing unchanged)
- **AND** SHALL NOT consult or write the `guest` map

### Requirement: JSON state files load and save through one module

The system SHALL provide a JSON state-file module that is the exclusive interface for reading and writing the session JSON state files (`state.json`, `bindings.json`, `topic-settings.json`). The module SHALL expose a load function that takes a file path and a caller-supplied default, and a save function that takes a file path and a value. Memory store files (`memory.md`, `user.md`) are Markdown and are NOT consumers of this module.

The load function SHALL implement the read recipe: `readFileSync` → `JSON.parse`; on `ENOENT` SHALL return the caller-supplied default; on `SyntaxError` SHALL log a warning and return the caller-supplied default; all other errors SHALL propagate (fail loud). The save function SHALL serialize the value as pretty-printed JSON with a trailing newline and write it via the existing `atomicWrite` primitive (tmp + rename). The module SHALL NOT own atomic-write itself — it wraps `src/fs.ts`'s `atomicWrite`.

Each caller SHALL supply its own default value and its own result type; the module is generic over `T`. The module SHALL NOT hardcode defaults for any specific state file.

#### Scenario: Load returns parsed JSON when the file exists

- **WHEN** `loadJsonFile<BindingsFile>(path, DEFAULT_BINDINGS)` is called and `path` contains valid JSON
- **THEN** it SHALL return the parsed value typed as `BindingsFile`
- **AND** SHALL NOT invoke the default

#### Scenario: Load returns default on ENOENT

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and the file does not exist
- **THEN** it SHALL return the caller-supplied default
- **AND** SHALL NOT throw

#### Scenario: Load returns default on malformed JSON and logs

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and the file contains invalid JSON
- **THEN** it SHALL log a warning including the path and error
- **AND** SHALL return the caller-supplied default
- **AND** SHALL NOT throw

#### Scenario: Load propagates non-ENOENT, non-Syntax errors

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and `readFileSync` throws a permission error
- **THEN** the error SHALL propagate to the caller
- **AND** the default SHALL NOT be returned

#### Scenario: Save writes atomically

- **WHEN** `saveJsonFile(path, value)` is called
- **THEN** it SHALL serialize `value` as `JSON.stringify(value, null, 2) + "\n"`
- **AND** SHALL write it via `atomicWrite` (tmp file + rename)
- **AND** SHALL NOT bypass atomicity

### Requirement: Transcript module owns the transcript seam

The system SHALL provide a single transcript module that is the exclusive interface to `transcript.jsonl`. The module SHALL export the `TranscriptEntry` type, an append writer, and a reader, and SHALL guarantee that every entry shape the writer can produce is readable by the reader without silent field loss.

The module is the seam between the agent layer (which writes transcripts on `message_end`) and the memory reflection pipeline (which reads the transcript tail). Format changes SHALL touch only this module.

#### Scenario: Writer is the sole producer

- **WHEN** any module appends a transcript entry
- **THEN** it SHALL do so by calling the transcript module's writer
- **AND** SHALL NOT construct JSONL lines or call `appendFile`/`writeFile` against `transcript.jsonl` directly

#### Scenario: Reader is the sole consumer

- **WHEN** any module reads transcript entries
- **THEN** it SHALL do so by calling the transcript module's reader
- **AND** SHALL NOT call `JSON.parse` on transcript lines directly

#### Scenario: Reader supports range reads for reflection cursoring

- **WHEN** the reflection pipeline requests entries after a given line offset (the cursor)
- **THEN** the reader SHALL return only entries whose line index is greater than the offset
- **AND** SHALL return each entry typed as `TranscriptEntry`

#### Scenario: Reader extracts displayable text uniformly

- **WHEN** a transcript entry's `content` is a text block, a tool-call block, a tool-result block, or an image block
- **THEN** the reader SHALL expose a helper that yields the displayable text for that entry
- **AND** the extraction logic SHALL live in the transcript module, not duplicated at read sites

### Requirement: Startup preflight verifies filesystem persistence

The system SHALL run a persistence check before starting long polling that proves the `GOBLIN_HOME` state directory is writable and that atomic write + rename works as expected.

#### Scenario: Atomic write test succeeds

- **WHEN** the preflight persistence check runs
- **THEN** it SHALL write a temporary file under `state/`, rename it to a target name, read it back, verify contents match, and delete it

#### Scenario: State directory is not writable

- **WHEN** the preflight persistence check cannot write to `state/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

#### Scenario: Atomic rename fails

- **WHEN** the preflight persistence check writes successfully but cannot rename the temp file
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

### Requirement: Startup preflight verifies workspace and scratch writability

The system SHALL verify that the `workspace/` and `scratch/` directories are writable before starting the bot, because prompt files, memory writes, and subagent work depend on them.

#### Scenario: Workspace is read-only

- **WHEN** the preflight check cannot write to `workspace/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

#### Scenario: Scratch is read-only

- **WHEN** the preflight check cannot write to `scratch/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

# sessions

## Requirements

### Requirement: Generate short session IDs

The system SHALL generate 10-character lowercase hexadecimal session IDs from UUID v4, providing approximately 1.1 trillion combinations.

#### Scenario: New session created for a surface

- **WHEN** `createForSurface()` creates a session
- **THEN** the resulting session SHALL have an ID of exactly 10 lowercase hexadecimal characters

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

The system SHALL create the complete existing filesystem layout when creating a session for a surface. The identity migration SHALL NOT rename or relocate session directories.

#### Scenario: Session created

- **WHEN** `createForSurface()` creates a session
- **THEN** it SHALL create `state/sessions/<id>/`, `workdir/`, `events.jsonl`, `transcript.jsonl`, and `state.json` as before

### Requirement: Write transcript entries on message completion

The system SHALL append final message entries to `transcript.jsonl` when pi emits `message_end` events. All writes and all reads of `transcript.jsonl` SHALL cross a single transcript module that owns the `TranscriptEntry` type, the writer, the reader, and a chunking helper for the memory indexing pipeline. No module other than the transcript module SHALL `JSON.parse` transcript lines or construct `TranscriptEntry` values directly.

The transcript module SHALL be the sole producer and the sole typing authority for transcript entries: `events.ts` SHALL write through the module's writer, the memory dreaming pipeline SHALL read through the module's reader, and the memory transcript indexer SHALL chunk and embed transcript entries via the module's chunking helper. The three consumers SHALL NOT maintain private transcript entry types; all SHALL reference the module's exported `TranscriptEntry` type. Format changes SHALL touch only this module.

The chunking helper SHALL accept a `TranscriptEntry` and return one or more bounded text snippets (max 500 chars each, truncating at word boundaries). Each snippet SHALL include the entry's timestamp, role, and session ID for provenance. The chunker SHALL skip tool-result entries with no displayable text and SHALL skip entries shorter than 8 characters.

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

- **WHEN** the dreaming pipeline reads a transcript entry written by `events.ts`
- **THEN** the reader SHALL parse the line into the same `TranscriptEntry` type the writer used
- **AND** SHALL NOT use a private re-declared subset type

#### Scenario: Round-trip preserves all fields the writer can produce

- **GIVEN** the writer can produce assistant entries with optional `api`/`provider`/`model`/`stopReason`/`errorMessage`, tool-result entries with `toolCallId`/`toolName`/`isError`, and content blocks including text, tool calls, and images (mimeType only)
- **WHEN** any such entry is written and then read back through the transcript module
- **THEN** the reader SHALL return a value whose fields match the writer's input
- **AND** SHALL NOT silently drop text that the writer recorded

#### Scenario: Writer is the sole producer

- **WHEN** any module appends a transcript entry
- **THEN** it SHALL do so by calling the transcript module's writer
- **AND** SHALL NOT construct JSONL lines or call `appendFile`/`writeFile` against `transcript.jsonl` directly

#### Scenario: Reader is the sole consumer

- **WHEN** any module reads transcript entries
- **THEN** it SHALL do so by calling the transcript module's reader
- **AND** SHALL NOT call `JSON.parse` on transcript lines directly

#### Scenario: Chunker produces bounded snippets

- **WHEN** the memory transcript indexer calls the chunking helper on a `TranscriptEntry` with 1200 chars of displayable text
- **THEN** the helper SHALL return 3 snippets: the first 500 chars (truncated at a word boundary), the next 500 chars, and the remaining 200 chars
- **AND** each snippet SHALL include the entry's timestamp, role, and session ID

#### Scenario: Chunker skips noise entries

- **WHEN** the chunking helper is called on a tool-result entry with no displayable text
- **THEN** the helper SHALL return an empty array
- **AND** the indexer SHALL skip the entry

#### Scenario: Chunker skips tiny entries

- **WHEN** the chunking helper is called on an entry with 5 characters of displayable text
- **THEN** the helper SHALL return an empty array

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

The system SHALL export `SessionManager` and `SessionState` from `src/sessions/mod.ts`. The obsolete `ChatLocator` SHALL no longer be exported; Telegram-native `Surface` and `SurfaceId` SHALL be defined by the pure shared surface module so sessions and orchestration can consume them without importing Telegram adapters.

#### Scenario: Session module import

- **WHEN** a module imports from `"./sessions/mod.ts"`
- **THEN** it SHALL have access to `SessionManager` and `SessionState`
- **AND** it SHALL use the shared surface module for surface identity types

### Requirement: Persist session titles

The session manager SHALL allow setting or clearing `SessionState.title` for an existing session and persist the updated state atomically.

#### Scenario: Title set

- **WHEN** `setTitle(sessionId, "memory refactor")` is called for an existing session
- **THEN** `state/sessions/<id>/state.json` SHALL contain `"title": "memory refactor"`
- **AND** resolving that session SHALL return the updated title

#### Scenario: Missing session title update

- **WHEN** `setTitle()` is called for a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: List resumable sessions excludes archive

The session list SHALL include unbound sessions and exclude archived sessions under `state/sessions/archive/<id>/`.

#### Scenario: List sessions

- **WHEN** `list()` is called
- **THEN** it SHALL return all `SessionState` objects found directly under the `state/sessions/` directory
- **AND** unbound sessions SHALL be included
- **AND** archived sessions SHALL be excluded

### Requirement: Topic settings file

The system SHALL maintain `state/topic-settings.json` under `$GOBLIN_HOME` as a canonical SurfaceId-keyed settings file containing values such as `projectDir` and pending project notice. It SHALL load and save through the JSON state-file module, use an empty canonical settings structure when missing or malformed, and propagate non-`ENOENT`, non-`SyntaxError` failures. All slot selection SHALL use `surfaceId(surface)` and SHALL NOT infer DM versus supergroup from numeric sign.

#### Scenario: Load canonical settings

- **WHEN** the file contains valid canonical settings
- **THEN** the loader SHALL return the SurfaceId-keyed structure via `loadJsonFile`

#### Scenario: Missing or malformed settings

- **WHEN** the file is missing or malformed
- **THEN** the loader SHALL return an empty canonical settings structure
- **AND** malformed JSON SHOULD emit a warning

#### Scenario: Non-JSON error propagates

- **WHEN** reading the file fails for a reason other than absence or malformed JSON
- **THEN** the error SHALL propagate

### Requirement: Topic settings atomic write

`state/topic-settings.json` SHALL be written using atomic write (tmp file + rename).

#### Scenario: Save topic settings

- **WHEN** `saveTopicSettings()` is called
- **THEN** it SHALL write to a temp file with a random suffix in `state/`
- **AND** rename it to `state/topic-settings.json` atomically

### Requirement: Persist scheduled turn definitions

The system SHALL persist scheduled turns atomically under `$GOBLIN_HOME`. Each in-memory schedule SHALL carry a complete captured `Surface`; the on-disk schedule record SHALL store its canonical `SurfaceId` rather than a partial locator. Existing schedule ID, session owner, kind, enabled/state fields, timing, recurrence, prompt, source, creation time, and last-run metadata SHALL remain unchanged.

#### Scenario: Schedule persisted with canonical surface identity

- **WHEN** a one-shot, recurring, or heartbeat schedule is created for an active session
- **THEN** the store SHALL persist `surfaceId(surface)` with the schedule
- **AND** SHALL NOT persist a legacy `locator` or separate routing flag

#### Scenario: Schedule round-trips

- **WHEN** a canonical schedule store is reloaded
- **THEN** each SurfaceId SHALL decode to the original complete surface before the schedule is returned to callers

#### Scenario: Invalid persisted surface fails loudly

- **WHEN** a schedule contains an invalid or unknown SurfaceId
- **THEN** loading SHALL fail with the schedule ID and validation error
- **AND** SHALL NOT dispatch or silently drop the schedule

### Requirement: Scheduled turns stay bound to their captured session surface

A scheduled turn SHALL run only when its captured session ID is still the active binding for its captured complete `Surface`. Validation SHALL call non-mutating `SessionManager.peekBinding(surface)` and SHALL NOT call `resolve(surface)`. A mismatch or archived session SHALL preserve the existing disable and last-run behavior. Dispatch SHALL pass the decoded complete surface to orchestration and Telegram delivery.

#### Scenario: Captured binding still matches

- **WHEN** a due schedule's exact SurfaceId still binds its captured session ID
- **THEN** the scheduler SHALL dispatch a fresh turn with the decoded surface

#### Scenario: Similar surface does not satisfy validation

- **WHEN** the captured surface is a guest surface
- **AND** only a DM or supergroup with the same numeric chat ID is bound to the session
- **THEN** validation SHALL treat the schedule as a binding mismatch
- **AND** SHALL NOT dispatch it

#### Scenario: Captured binding no longer matches

- **WHEN** `peekBinding(surface)` returns no session or a different session
- **THEN** the scheduler SHALL disable the schedule, record `binding-mismatch`, and SHALL NOT prompt the old session

#### Scenario: Archived captured session

- **WHEN** the captured session is archived and its surface binding has been cleared
- **THEN** the scheduler SHALL disable the schedule, record `archived`, and SHALL NOT auto-create or resume a session

### Requirement: Heartbeat schedule is explicit and session-scoped

The system SHALL represent heartbeat as an explicit session-scoped schedule kind. Heartbeat SHALL be disabled by default. Enabling heartbeat without an interval SHALL use a 30-minute interval. The heartbeat prompt SHALL be generated by the system, prefixed with the literal marker `[heartbeat]`, and SHALL ask Goblin whether there is anything useful, timely, or important to say for the current session; it MUST NOT claim a user asked a new question. The `[heartbeat]` prefix SHALL make the prompt distinguishable from user-authored text at the agent layer and in transcripts.

At dispatch time, the heartbeat prompt body SHALL be resolved with a first-non-empty-wins order across two candidate files and a system constant:

1. **Session-scoped:** `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md`, via `heartbeatMdPathForSession(home, sessionId)`.
2. **Global:** `$GOBLIN_HOME/workspace/HEARTBEAT.md`, via `heartbeatMdPath(home)`.
3. **Constant:** the system-owned `HEARTBEAT_PROMPT` defined in the scheduler loop.

If the session-scoped file exists and contains non-whitespace content, its content SHALL be used and the global file SHALL NOT be consulted. If the session-scoped file is absent or whitespace-only, the system SHALL fall back to the global file with the same rules. If neither file yields content, the system SHALL use the constant as-is. In every case, the dispatched prompt SHALL begin with exactly one `[heartbeat]` marker.

The heartbeat schedule record SHALL store no user prompt text; the prompt is resolved at dispatch time, not captured at schedule creation time. When a file (session-scoped or global) yields content, the system SHALL prepend `[heartbeat] ` to the file's content. When the constant is used, it is returned as-is (it already includes the prefix).

When a file yields content, trailing whitespace SHALL be stripped before prepending the marker; leading whitespace SHALL be preserved (the user may intend an indented first line as part of the body). A file that contains only whitespace SHALL be treated as empty and SHALL fall through to the next candidate.

Non-`ENOENT` read errors on either file SHALL propagate (fail loud, per AGENTS.md); the heartbeat turn SHALL NOT be dispatched when a read error other than `ENOENT` occurs.

#### Scenario: Heartbeat default disabled

- **WHEN** a new session is created
- **THEN** no heartbeat schedule SHALL exist for that session

#### Scenario: Heartbeat enabled with default interval

- **WHEN** the user enables heartbeat without specifying an interval
- **THEN** the schedule store SHALL contain an enabled heartbeat schedule for that session with `intervalMs = 1800000`

#### Scenario: Session-scoped HEARTBEAT.md takes precedence

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md` exists with content
- **AND** `$GOBLIN_HOME/workspace/HEARTBEAT.md` also exists with different content
- **THEN** the scheduler SHALL dispatch a fresh turn using the session-scoped file's content
- **AND** the global file SHALL NOT be consulted

#### Scenario: Falls back to global when session-scoped absent

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** no session-scoped `HEARTBEAT.md` exists for the session
- **AND** `$GOBLIN_HOME/workspace/HEARTBEAT.md` exists with content
- **THEN** the scheduler SHALL dispatch a fresh turn using the global file's content
- **AND** the prompt SHALL begin with exactly one `[heartbeat]` marker

#### Scenario: Falls back to constant when both absent

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** neither a session-scoped nor global `HEARTBEAT.md` exists
- **THEN** the scheduler SHALL dispatch a fresh turn with the system-owned constant prompt
- **AND** the prompt SHALL begin with exactly one `[heartbeat]` marker (no double-prefixing)

#### Scenario: Session-scoped whitespace-only falls through to global

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** the session-scoped `HEARTBEAT.md` exists but is empty or whitespace-only
- **AND** the global `HEARTBEAT.md` exists with content
- **THEN** the scheduler SHALL use the global file's content

#### Scenario: Session-scoped edits take effect on next heartbeat

- **GIVEN** heartbeat is enabled for a session and a heartbeat turn has run with the current session-scoped `HEARTBEAT.md` content
- **WHEN** the user edits `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md`
- **AND** the next heartbeat schedule becomes due
- **THEN** the dispatched prompt SHALL use the updated file content (resolution is at dispatch time, not creation time)

#### Scenario: Non-ENOENT read error on either file propagates

- **WHEN** a heartbeat schedule is due and the session remains bound
- **AND** either the session-scoped or global `HEARTBEAT.md` exists but cannot be read for a reason other than `ENOENT`
- **THEN** the read error SHALL propagate
- **AND** the heartbeat turn SHALL NOT be dispatched

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

### Requirement: Session-scoped heartbeat prompt file path

The `src/sessions/paths.ts` module SHALL export `heartbeatMdPathForSession(home, sessionId)`, which SHALL resolve to `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md`. This path is session state and SHALL be accessed exclusively through this helper (per the AGENTS.md rule that `$GOBLIN_HOME` is touched from the code tree only through sanctioned path modules). The helper SHALL depend only on `node:path` and the existing `sessionDir` helper in the same module.

The helper SHALL validate `sessionId` against the goblin session-id format (lowercase hex, as produced by `makeSessionId` = `randomUUID().replace(/-/g,"").slice(0,10)`) before joining. A `sessionId` containing path separators (`/`, `\`) or `..` SHALL cause the helper to throw, rather than resolving to a path outside the session directory. This is defense-in-depth: session ids are goblin-generated and never derived from user input, but the guard prevents any future caller mistake from traversing out of `state/sessions/`. The same format-validation guard applies to `sessionDir`, `statePath`, and `transcriptPath` if they do not already enforce it (see tasks).

#### Scenario: Path resolves under session directory

- **WHEN** `heartbeatMdPathForSession(home, "abc123def0")` is called with a valid hex session id
- **THEN** it SHALL resolve to `<home>/state/sessions/abc123def0/HEARTBEAT.md`

#### Scenario: Reuses sessionDir helper

- **WHEN** the module is compiled
- **THEN** `heartbeatMdPathForSession` SHALL be defined in terms of `sessionDir(home, sessionId)` (the same helper backing `statePath` and `transcriptPath`), not by re-deriving the path independently

#### Scenario: Path traversal rejected

- **WHEN** `heartbeatMdPathForSession(home, "../escape")` or a session id containing `/` is passed
- **THEN** the helper SHALL throw
- **AND** SHALL NOT return a path outside `state/sessions/`

### Requirement: Internal session creation for dreaming

The `SessionManager` SHALL support creating internal sessions that have no Telegram binding, via a new `ensureInternal(id: string): SessionState` method. Internal sessions are used by the dreaming pipeline (session id `__goblin_dreaming__`) and are not user-facing.

`ensureInternal(id)` SHALL be idempotent: if `sessions/<id>/state.json` already exists, it SHALL load and return the existing state. Otherwise, it SHALL create the session directory + files (transcript.jsonl, events.jsonl, metrics.jsonl), write `state.json` with `{ id, createdAt: <now>, chatId: 0 }`, and return the new state. No binding entry SHALL be written to `bindings.json`.

`chatId: 0` is a sentinel value. Telegram chat IDs are never 0 (user IDs are positive, group/channel IDs are negative). The sentinel is safe and distinguishes internal sessions from Telegram-bound sessions.

Internal sessions SHALL be excluded from `SessionManager.list()`. The `list()` method scans `sessions/` and already skips `archive/`; it SHALL also skip any session whose `state.chatId === 0`.

Internal sessions SHALL NOT be archived. `archive()` SHALL NOT be called on an internal session. The session persists for the lifetime of the goblin process.

The `SchedulerSessionSource` seam SHALL gain `ensureInternal(id: string): SessionState` so the scheduler (and dreaming pipeline) can obtain the dreaming session without depending on the full `SessionManager`.

#### Scenario: ensureInternal creates session on first call

- **GIVEN** no session directory exists for id `__goblin_dreaming__`
- **WHEN** `ensureInternal("__goblin_dreaming__")` is called
- **THEN** a session directory SHALL be created at `sessions/__goblin_dreaming__/`
- **AND** `state.json` SHALL be written with `{ id: "__goblin_dreaming__", createdAt: <ISO timestamp>, chatId: 0 }`
- **AND** no binding entry SHALL be written to `bindings.json`
- **AND** the `SessionState` SHALL be returned

#### Scenario: ensureInternal is idempotent

- **GIVEN** a session already exists for id `__goblin_dreaming__` with `chatId: 0`
- **WHEN** `ensureInternal("__goblin_dreaming__")` is called again
- **THEN** the existing `state.json` SHALL be loaded and returned
- **AND** no new directory or files SHALL be created
- **AND** no binding entry SHALL be written

#### Scenario: Internal session excluded from list

- **GIVEN** sessions `abc123` (chatId: 100), `def456` (chatId: -200), and `__goblin_dreaming__` (chatId: 0) exist
- **WHEN** `SessionManager.list()` is called
- **THEN** the result SHALL include `abc123` and `def456`
- **AND** SHALL NOT include `__goblin_dreaming__`

#### Scenario: Internal session is never archived

- **GIVEN** the dreaming session `__goblin_dreaming__` exists with `chatId: 0`
- **WHEN** `archive("__goblin_dreaming__")` is called
- **THEN** the call SHALL be rejected (throw or no-op)
- **AND** the session directory `sessions/__goblin_dreaming__/` SHALL remain in place
- **AND** `state.json` SHALL remain unchanged

### Requirement: metrics.jsonl is archived with the session

When a session is archived, the `metrics.jsonl` file SHALL be moved together with the rest of the session directory to `state/sessions/archive/<id>/metrics.jsonl`.

#### Scenario: Archive session

- **WHEN** a session is archived
- **THEN** `state/sessions/<id>/metrics.jsonl` SHALL be moved to `state/sessions/archive/<id>/metrics.jsonl`
- **AND** the original path SHALL NOT exist

### Requirement: Persist one binding map keyed by SurfaceId

The session manager SHALL persist active Telegram bindings in `state/bindings.json` as one `surfaces` map from canonical `SurfaceId` to session ID. It SHALL use the complete `Surface` supplied by the caller to derive the key. DM, topicless supergroup, guest, and each topic container SHALL remain distinct even when their numeric identifiers match. Binding lookup, creation, rebinding, clearing, and archive cleanup SHALL operate on this one map and SHALL NOT branch on chat-ID sign or separate routing flags.

#### Scenario: Binding is stored under canonical identity

- **WHEN** a session is bound to a valid surface
- **THEN** `bindings.json` SHALL contain the session ID under `surfaceId(surface)`
- **AND** it SHALL NOT add an entry to legacy `dm`, `topics`, `supergroups`, or `guest` maps

#### Scenario: Numeric collision does not collide semantically

- **WHEN** a DM, guest, and topicless supergroup have the same numeric chat ID
- **THEN** all three bindings SHALL coexist under different keys

#### Scenario: Topic containers do not collide

- **WHEN** private, forum-supergroup, and direct-messages topic surfaces have equal numeric chat and topic IDs
- **THEN** their bindings SHALL coexist under different keys

#### Scenario: Archive clears every surface binding

- **WHEN** a session bound to one or more surfaces is archived
- **THEN** every `surfaces` entry referencing that session SHALL be removed
- **AND** unrelated surface bindings SHALL remain unchanged

### Requirement: Resolve sessions from complete Surface values

`SessionManager.resolve(surface)` SHALL accept a complete `Surface` with no routing options. An unbound DM SHALL return `null` until explicitly created. Topic surfaces of every container, topicless supergroups, and guest surfaces SHALL auto-create on first resolve. Existing bindings SHALL return their session state. A stale DM binding SHALL be warned, removed, and return `null`; stale auto-creating surface bindings SHALL be warned and replaced with a newly created session. These identity changes SHALL preserve the existing session-creation and stale-binding behavior.

#### Scenario: Unbound DM remains explicit-create

- **WHEN** `resolve()` receives an unbound `{ kind: "dm", chatId }` surface
- **THEN** it SHALL return `null`
- **AND** SHALL NOT create a session

#### Scenario: Bound DM resolves

- **WHEN** `resolve()` receives a DM surface with a live binding
- **THEN** it SHALL return the bound session state

#### Scenario: Any topic container auto-creates

- **WHEN** `resolve()` receives an unbound topic surface whose container is `private`, `supergroup`, or `direct-messages`
- **THEN** it SHALL create and bind a new session for that exact surface
- **AND** the new `state.json` SHALL NOT contain `projectDir`

#### Scenario: Topicless supergroup auto-creates

- **WHEN** `resolve()` receives an unbound topicless supergroup surface
- **THEN** it SHALL create and bind a new session

#### Scenario: Guest auto-creates

- **WHEN** `resolve()` receives an unbound guest surface
- **THEN** it SHALL create and bind a new session without requiring `/new`

#### Scenario: Stale DM is cleared

- **WHEN** a DM binding points to a missing `state.json`
- **THEN** `resolve()` SHALL log a warning, remove that SurfaceId entry atomically, and return `null`

#### Scenario: Stale auto-creating surface is repaired

- **WHEN** a topic, topicless supergroup, or guest binding points to a missing `state.json`
- **THEN** `resolve()` SHALL log a warning, create a new session, replace that exact SurfaceId binding, and return the new state

### Requirement: Surface-based creation and rebinding preserve conversation identity

The session manager SHALL provide `createForSurface(surface, options?)` and `bindExistingToSurface(sessionId, surface)`. Creating for a surface SHALL create a new session and update only that surface's binding; any displaced session directory SHALL remain intact and resumable. Binding an existing session SHALL update only the destination binding without rewriting the session's historical `chatId` or `topicId`. Surface routing identity SHALL remain a binding concern, separate from the durable session identity.

#### Scenario: Create a new DM session

- **WHEN** `createForSurface(dmSurface)` is called for an already-bound DM
- **THEN** it SHALL create a session with a new ID
- **AND** point only the DM surface binding at the new ID
- **AND** leave the previous session directory intact

#### Scenario: Create for a topic uses its full identity

- **WHEN** `createForSurface(topicSurface)` is called
- **THEN** it SHALL bind the session under the topic's container-aware SurfaceId

#### Scenario: Bind an existing session

- **WHEN** `bindExistingToSurface(sessionId, surface)` is called for a live session
- **THEN** it SHALL bind that exact surface to the existing session without creating another session
- **AND** any displaced session SHALL remain stored and resumable

#### Scenario: Missing session cannot be bound

- **WHEN** `bindExistingToSurface()` receives a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: Peek binding is complete and non-mutating

`SessionManager.peekBinding(surface)` SHALL accept a complete `Surface`, read only the binding at its canonical SurfaceId, and return its session ID and state when both exist. It SHALL return `null` for absent or stale bindings and SHALL never create, repair, or infer another surface binding.

#### Scenario: Exact binding is returned

- **WHEN** `peekBinding(surface)` is called for a live binding
- **THEN** it SHALL return that binding's session ID and state

#### Scenario: Similar surface is not substituted

- **WHEN** only a guest binding exists for a numeric chat ID
- **AND** `peekBinding()` is called with a DM surface carrying the same number
- **THEN** it SHALL return `null`

#### Scenario: Peek never auto-creates

- **WHEN** `peekBinding()` is called for an unbound topic, supergroup, or guest surface
- **THEN** it SHALL return `null`
- **AND** SHALL NOT write bindings or session files

### Requirement: Surface settings are keyed by SurfaceId

`state/topic-settings.json` SHALL persist per-surface settings in one `surfaces` map keyed by canonical `SurfaceId`. `SessionManager.getProjectDir(surface)`, `bindProjectDir(surface, projectDir)`, and `consumeProjectNotice(surface)` SHALL accept complete surfaces and access only the corresponding key. They SHALL preserve the current project-directory and pending-notice behavior and atomic-write guarantees. Settings for numerically similar surface kinds and topic containers SHALL not collide.

#### Scenario: Read and write project directory

- **WHEN** `bindProjectDir(surface, "/home/daniel/project")` is called
- **THEN** `topic-settings.json` SHALL store that value under `surfaceId(surface)`
- **AND** `getProjectDir(surface)` SHALL return it

#### Scenario: Clear project directory

- **WHEN** `bindProjectDir(surface, undefined)` is called
- **THEN** the project directory SHALL be removed from that surface's settings
- **AND** an empty settings record SHALL be pruned

#### Scenario: Similar surfaces keep separate settings

- **WHEN** two surfaces share numeric identifiers but differ in kind or topic container
- **THEN** setting a project directory for one SHALL NOT change the other

#### Scenario: Pending notice uses the same key

- **WHEN** a project notice is queued and consumed for a surface
- **THEN** it SHALL be read and cleared only from that surface's canonical settings record

### Requirement: Legacy surface state migrates before polling

The filesystem migration module SHALL own one strict monotonic `stateVersion` and an ordered offline plan/apply registry. Only an absent version file SHALL mean version 0. Malformed JSON or schema, unreadable files, negative or non-integer values, and versions newer than the running code MUST fail before backup or persisted-input mutation. Startup SHALL require exact equality with `CURRENT_STATE_VERSION`, refuse to poll on mismatch, and name `bun run migrate` with the service stopped; it SHALL NOT execute filesystem conversion.

Surface conversion SHALL be canonical step 1, mapping version 0 to 1. Before altering any persisted input, the runner SHALL plan every pending step in order, with later planners consuming projected outputs from earlier plans. Any planning failure SHALL leave every step unapplied. The migration command SHALL then snapshot every persisted root named by those plans, preserving prior contents and path absence, before setup creates an optional snapshotted root. It SHALL apply plans in order and write each successor version only after that step succeeds. The command SHALL be the sole owner of the migration recovery backup; an unexpected apply failure requires whole-run backup restoration before retry and SHALL NOT rely on startup, mixed-generation loading, or an independent marker.

Step 1 SHALL parse and derive canonical replacements for legacy `bindings.json`, `topic-settings.json`, and schedule `locator` records before its applier writes. It SHALL validate every produced Surface and replace each JSON file through the existing atomic-write path. A legacy `topics` entry has no default container: planning SHALL require persisted evidence that uniquely and consistently proves `private` or `supergroup` for the same numeric topic, and SHALL fail when evidence is absent or conflicting. It SHALL NOT infer `direct-messages`. A legacy schedule SHALL use explicit legacy container metadata when present and otherwise SHALL be matched by both chat identity and captured Conversation/session ID against available bindings. A topic or schedule that cannot map to exactly one Surface SHALL fail without silently retargeting it.

`scripts/update.sh` SHALL stop Goblin before invoking the canonical migration command, perform no narrower duplicate migration backup, restart only after successful migration, and leave the service stopped when migration fails.

#### Scenario: Legacy bindings migrate without collisions

- **GIVEN** persisted state is at version 0
- **AND** `bindings.json` contains legacy `dm`, `topics`, `supergroups`, and `guest` entries
- **WHEN** the offline migration command applies step 1
- **THEN** each entry SHALL be converted to the corresponding canonical SurfaceId key
- **AND** every referenced session ID SHALL be preserved
- **AND** version 1 SHALL be written only after every step-1 output succeeds

#### Scenario: Legacy topic with explicit container evidence migrates

- **GIVEN** a legacy topic binding and its corroborating persisted record identify the same chat, topic, and session as a forum supergroup
- **WHEN** step 1 is planned
- **THEN** the binding SHALL map to `topic:supergroup`
- **AND** any matching topic setting or schedule SHALL use that same canonical SurfaceId

#### Scenario: Ambiguous legacy topic fails during preflight

- **GIVEN** a legacy topic binding or setting has no persisted container evidence, or its evidence conflicts
- **WHEN** the pending migration chain is planned
- **THEN** planning SHALL fail with the source path, chat ID, topic ID, and candidate canonical SurfaceIds
- **AND** no pending migration step SHALL be applied
- **AND** migration SHALL NOT default the topic to `supergroup`

#### Scenario: Legacy settings migrate

- **WHEN** `topic-settings.json` contains legacy DM, topic, and supergroup settings
- **THEN** each non-empty settings object SHALL be planned under the corresponding SurfaceId
- **AND** its `projectDir` and pending notice SHALL be unchanged by step 1

#### Scenario: Legacy schedule is inferred from its binding

- **WHEN** a legacy topicless schedule lacks an explicit kind
- **AND** its chat ID and session ID match exactly one DM, supergroup, or guest binding
- **THEN** step 1 SHALL plan that binding's SurfaceId without changing the schedule's owner, timing, prompt, state, or last-run metadata

#### Scenario: Ambiguous legacy schedule fails during preflight

- **WHEN** a legacy schedule matches zero or multiple candidate Surfaces
- **THEN** planning SHALL fail with a diagnostic identifying the schedule and candidates
- **AND** no pending migration step SHALL be applied

#### Scenario: Later-step failure prevents earlier-step mutation

- **GIVEN** persisted state is at version 0
- **AND** Surface step 1 has a valid plan
- **AND** environment step 2 detects an invalid project authority while consuming step 1's projected output
- **WHEN** the migration command preflights the pending 0-to-2 chain
- **THEN** step 1 SHALL NOT be applied
- **AND** `stateVersion` SHALL remain 0
- **AND** bindings, settings, schedules, workspace, and legacy workdir SHALL remain unchanged

#### Scenario: Invalid state version fails closed

- **WHEN** `state-version.json` is malformed, unreadable, has the wrong schema, contains a negative or non-integer value, or names a version newer than the running code
- **THEN** startup and the migration command SHALL fail with the invalid path and value/reason
- **AND** migration SHALL take no backup and mutate no persisted input

#### Scenario: Missing version alone means legacy version zero

- **WHEN** `state-version.json` is absent
- **THEN** the migration command SHALL treat persisted state as version 0
- **AND** no other read or parse failure SHALL receive that fallback

#### Scenario: Backup precedes setup mutation

- **GIVEN** a pending plan names an optional persisted root that does not yet exist
- **WHEN** the real migration CLI crosses its first mutation boundary
- **THEN** the recovery snapshot SHALL record that absence before any directory-creation helper runs
- **AND** restoring the backup SHALL remove paths created by the failed attempt

#### Scenario: Update leaves failed migration offline

- **WHEN** production update reaches filesystem migration
- **THEN** it SHALL stop Goblin before invoking the canonical backup/migration boundary
- **AND** a migration failure SHALL leave Goblin stopped
- **AND** only successful migration SHALL permit restart

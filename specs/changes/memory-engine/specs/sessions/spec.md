# sessions

## MODIFIED Requirements

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

## ADDED Requirements

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

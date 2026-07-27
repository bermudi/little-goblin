# sessions

## ADDED Requirements

### Requirement: Transcript provenance migration is conservative and offline

The canonical offline migration runner SHALL migrate legacy Conversation transcript provenance as filesystem step 3, after canonical Surface and execution-environment migration and before Conversation lifecycle migration. The transcript step SHALL precompute and validate every candidate rewrite before its first write, validate all existing fields through the transcript module, preserve line order and every existing field, and replace each changed transcript file atomically. `CURRENT_STATE_VERSION` SHALL advance from 2 to 3 only after the step succeeds.

The step SHALL preserve existing valid per-entry `sourceSurfaceId` and MAY add `sourceSurfaceId` only where persisted historical evidence proves one canonical event source. In this deployment the only such evidence is an entry's own existing valid per-entry provenance; no named historical-evidence store exists, and legacy `SessionState` carries only creation-time `chatId`/`topicId`. Conversation creation metadata alone, the current binding alone, shared chat numbers, shared memory scope, and shared Execution Environment SHALL NOT prove event-time provenance. If a whole legacy entry or file cannot be attributed without guessing, provenance SHALL remain absent. Existing valid per-entry provenance SHALL be preserved; invalid provenance SHALL remain non-authoritative and be reported through a bounded warning/count rather than rewritten to a guessed Surface. The step SHALL report a bounded count of legacy entries left with absent provenance without emitting transcript content. Non-`ENOENT` read/write errors and invalid transcript rewrites MUST fail the migration command before `stateVersion` advances.

The step SHALL run only through `bun run migrate` with the service stopped. It SHALL have no independent completion marker and SHALL NOT be required to accept mixed-generation files, resume after partial writes, or converge idempotently; recovery from failure restores the canonical migration command's backup.

#### Scenario: Existing valid per-entry provenance is preserved

- **WHEN** a legacy transcript entry already carries a canonical valid `sourceSurfaceId`
- **THEN** the offline step SHALL preserve that SurfaceId unchanged
- **AND** SHALL not alter any other field or line position

#### Scenario: Legacy entry without provenance stays null

- **GIVEN** a legacy transcript entry has no `sourceSurfaceId` and no historical evidence source exists
- **WHEN** the offline step runs
- **THEN** it SHALL leave `sourceSurfaceId` absent
- **AND** SHALL report the entry in a bounded unknown-provenance count without emitting transcript content
- **AND** SHALL not stamp any Surface derived from the current binding or creation metadata

#### Scenario: Current binding is not history

- **GIVEN** a legacy Conversation is currently bound to Surface Y
- **AND** its transcript entries have no event-time Surface evidence
- **WHEN** the offline step runs
- **THEN** it SHALL leave `sourceSurfaceId` absent
- **AND** SHALL not stamp Y across the transcript

#### Scenario: Version 2 deployment migrates

- **GIVEN** filesystem `stateVersion` is 2
- **WHEN** the operator runs `bun run migrate` with the service stopped
- **THEN** transcript provenance step 3 SHALL run exactly once
- **AND** `stateVersion` SHALL become 3 only after the step succeeds

#### Scenario: Startup sees pre-provenance state

- **WHEN** Goblin starts before the offline transcript step has advanced filesystem `stateVersion` to 3
- **THEN** startup SHALL refuse to poll
- **AND** SHALL direct the operator to run `bun run migrate` with the service stopped

## MODIFIED Requirements

### Requirement: Write transcript entries on message completion

The system SHALL append final message entries to `transcript.jsonl` when pi emits `message_end` events. All reads and writes SHALL continue to cross the single transcript module, which owns `TranscriptEntry`, normalization, parsing, range reads, display-text extraction, and chunking.

`TranscriptEntry` SHALL add optional `sourceSurfaceId: SurfaceId`. Every new entry produced by a user-visible main conversation runtime—including user, assistant, tool-result, and synthetic assistant entries—MUST carry the canonical SurfaceId captured by that runtime. The writer SHALL require explicit context discriminated as Surface-backed or internal; a Surface-backed write cannot omit provenance, while an internal write SHALL omit it. `AgentRunner` SHALL freeze that context from its completed runtime capture, and event/synthetic callers SHALL pass the runner or its context rather than a Conversation ID or binding reader. If a synthetic user-visible reply has no current writer context, the caller SHALL deliver it without appending JSONL and emit a bounded `no-transcript-writer-context` signal. Callers MUST NOT construct transcript values directly, create a runtime merely to stamp a reply, query a current binding during event handling, or rewrite old entries when a Conversation moves.

The reader SHALL expose normalized typed entries to ordinary consumers and a named migration-only lossless-record operation only to `TranscriptProvenanceMigrator`. Ordinary readers, indexers, dreaming, commands, and intake MUST NOT import or receive raw records; a static boundary test SHALL enforce that restriction. A normalized entry SHALL expose `sourceSurfaceId` only when its raw field is a canonical SurfaceId; absent, non-string, malformed, unknown-version, and non-canonical raw values SHALL leave typed provenance unavailable while preserving readable entry text and fields. An unchanged raw record SHALL be re-emitted byte-for-byte. Any rewrite SHALL preserve every raw field, including an invalid `sourceSurfaceId`; migration MAY add proven provenance only where the field is absent and SHALL NOT replace invalid input with a guess. The range reader's `TranscriptLine` and the chunker's output SHALL preserve validated provenance for indexing and dreaming. Existing max-500-character chunking, timestamp/role/Conversation-ID provenance, noise skipping, and round-trip guarantees SHALL remain unchanged.

#### Scenario: Runtime message carries event-time Surface

- **WHEN** a Surface-backed runtime receives `message_end`
- **THEN** the transcript module SHALL append the normalized entry with the runtime capture's `sourceSurfaceId`
- **AND** SHALL not inspect the Conversation's current binding

#### Scenario: Conversation moves between entries

- **GIVEN** earlier entries were written by a runtime on Surface X
- **WHEN** the Conversation moves and a replacement runtime on Y writes later entries
- **THEN** earlier entries SHALL retain X
- **AND** later entries SHALL carry Y

#### Scenario: Synthetic user-visible reply is attributed

- **WHEN** intake or a command appends a synthetic assistant reply for a bound user-visible runtime
- **THEN** it SHALL supply that runtime's captured SurfaceId

#### Scenario: Synthetic reply has no runtime context

- **WHEN** a user-visible synthetic reply is delivered without a current runtime writer context
- **THEN** it SHALL not append a transcript entry
- **AND** it SHALL not consult a binding or create a runtime to obtain provenance
- **AND** it SHALL emit a bounded `no-transcript-writer-context` signal

#### Scenario: Internal entry has no Surface

- **WHEN** an explicitly internal writer appends an internal model entry
- **THEN** `sourceSurfaceId` SHALL be absent
- **AND** no zero-chat or internal SurfaceId SHALL be manufactured

#### Scenario: Reader and chunker preserve provenance

- **WHEN** a valid entry with `sourceSurfaceId` is read and chunked
- **THEN** every resulting chunk SHALL expose the same validated SurfaceId
- **AND** all previously accepted transcript fields SHALL round-trip unchanged

#### Scenario: Legacy entry remains readable

- **WHEN** a transcript line has no `sourceSurfaceId` or carries an invalid legacy value
- **THEN** its text and other valid fields SHALL remain readable
- **AND** its normalized typed provenance SHALL be unavailable for indexing and dreaming
- **AND** migration/rewrite code SHALL preserve the original invalid raw field rather than replacing it with a guess

### Requirement: Transcript module owns the transcript seam

The transcript module SHALL remain the exclusive typed interface to `transcript.jsonl`. It SHALL export the provenance-aware `TranscriptEntry`, Surface-backed and internal writer operations, reader, display-text extraction, range reader, and chunker. The writer context SHALL make omission of provenance impossible for new user-visible writes and explicit for internal writes. No consumer SHALL parse JSONL, append lines, construct transcript entries, or resolve Surface provenance independently.

#### Scenario: Surface-backed writer is explicit

- **WHEN** a main runtime or synthetic-reply caller writes an entry
- **THEN** it SHALL call the transcript module with a validated captured SurfaceId
- **AND** the module SHALL be the only code that places `sourceSurfaceId` on disk

#### Scenario: Reader is the sole provenance parser

- **WHEN** indexing or dreaming consumes transcript provenance
- **THEN** it SHALL use the transcript module's validated entry/line/chunk output
- **AND** SHALL not parse SurfaceId fields from raw JSON elsewhere

#### Scenario: Lossless records stay in migration

- **WHEN** transcript provenance migration needs a raw record for a potential rewrite
- **THEN** only `TranscriptProvenanceMigrator` SHALL obtain it through the transcript module's migration-only operation
- **AND** ordinary readers, indexers, dreaming, commands, and intake SHALL receive only normalized typed entries

#### Scenario: Range reads retain line alignment

- **WHEN** a range read encounters valid, malformed, legacy, and provenance-bearing lines
- **THEN** it SHALL preserve the accepted logical-line cursor behavior
- **AND** valid provenance SHALL remain associated with its original line

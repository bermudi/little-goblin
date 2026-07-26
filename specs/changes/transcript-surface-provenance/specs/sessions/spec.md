# sessions

## ADDED Requirements

### Requirement: Transcript provenance migration is conservative and restart-safe

Startup SHALL migrate legacy Conversation transcript provenance after canonical Surface identity exists and before provenance-aware indexing or Conversation lifecycle migration runs. It SHALL precompute every candidate rewrite before its first transcript write, validate all existing fields through the transcript module, preserve line order and every existing field, and replace each changed transcript file atomically. Mixed migrated/unmigrated files SHALL be accepted on restart and the migration SHALL converge idempotently.

Migration MAY add `sourceSurfaceId` only where persisted historical evidence proves one canonical event source. Conversation creation metadata alone, the current binding alone, shared chat numbers, shared memory scope, and shared Execution Environment SHALL NOT prove event-time provenance. If a whole legacy entry or file cannot be attributed without guessing, provenance SHALL remain absent. Existing valid per-entry provenance SHALL be preserved; invalid provenance SHALL remain non-authoritative and be reported through a bounded migration warning/count rather than rewritten to a guessed Surface.

A migration completion marker SHALL be committed only after all transcript files have been processed successfully. Non-`ENOENT` read/write errors and invalid transcript rewrites MUST fail startup; already completed atomic file replacements SHALL remain safe for the next idempotent attempt.

#### Scenario: Explicit historical evidence permits backfill

- **WHEN** persisted historical evidence uniquely identifies the canonical source Surface for a legacy transcript entry
- **THEN** migration SHALL atomically add that SurfaceId without changing any other field or line position

#### Scenario: Current binding is not history

- **GIVEN** a legacy Conversation is currently bound to Surface Y
- **AND** its transcript entries have no event-time Surface evidence
- **WHEN** migration runs
- **THEN** it SHALL leave `sourceSurfaceId` absent
- **AND** SHALL not stamp Y across the transcript

#### Scenario: Interrupted migration resumes

- **WHEN** startup stops after atomically replacing some transcripts but before recording completion
- **THEN** the next startup SHALL accept those entries, process the remaining files, and converge without duplicate fields or reordered lines

## MODIFIED Requirements

### Requirement: Write transcript entries on message completion

The system SHALL append final message entries to `transcript.jsonl` when pi emits `message_end` events. All reads and writes SHALL continue to cross the single transcript module, which owns `TranscriptEntry`, normalization, parsing, range reads, display-text extraction, and chunking.

`TranscriptEntry` SHALL add optional `sourceSurfaceId: SurfaceId`. Every new entry produced by a user-visible main conversation runtime—including user, assistant, tool-result, and synthetic assistant entries—MUST carry the canonical SurfaceId captured by that runtime. The writer SHALL require explicit context discriminated as Surface-backed or internal; a Surface-backed write cannot omit provenance, while an internal write SHALL omit it. Legacy parsed entries MAY omit it. Callers MUST NOT construct transcript values directly, query a current binding during event handling, or rewrite old entries when a Conversation moves.

The reader SHALL preserve every existing field plus `sourceSurfaceId`. It SHALL validate canonical SurfaceIds without discarding the entry's text when legacy provenance is absent or invalid. The range reader's `TranscriptLine` and the chunker's output SHALL preserve validated provenance for indexing and dreaming. Existing max-500-character chunking, timestamp/role/Conversation-ID provenance, noise skipping, and round-trip guarantees SHALL remain unchanged.

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
- **AND** its provenance SHALL be treated as unavailable for indexing and dreaming

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

#### Scenario: Range reads retain line alignment

- **WHEN** a range read encounters valid, malformed, legacy, and provenance-bearing lines
- **THEN** it SHALL preserve the accepted logical-line cursor behavior
- **AND** valid provenance SHALL remain associated with its original line

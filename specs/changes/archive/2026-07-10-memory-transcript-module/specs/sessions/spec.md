# sessions

## MODIFIED Requirements

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

## ADDED Requirements

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

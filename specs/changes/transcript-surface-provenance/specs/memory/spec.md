# memory

## ADDED Requirements

### Requirement: Transcript provenance drives chat indexing

The transcript indexer SHALL derive each transcript chunk's `chat_id` from the validated `sourceSurfaceId` carried by that chunk's source entry. It SHALL parse the SurfaceId through the canonical Surface codec and use the decoded Surface's `chatId`. It MUST NOT read Conversation/session state, current bindings, creation metadata, or one file-level chat value as indexing authority.

A single `transcript/<conversationId>` scope MAY contain chunks with different `chat_id` values. An absent, malformed, non-canonical, or migration-ambiguous source Surface SHALL produce `chat_id = null` for that entry's chunks. Those chunks SHALL be excluded from default chat-scoped transcript search but remain eligible when `all_chats = true` or an explicit Surface-free internal search requests all transcripts.

#### Scenario: Moved Conversation indexes both source chats

- **GIVEN** one transcript contains an entry from Surface X in chat A and a later entry from Surface Y in chat B
- **WHEN** transcript sync indexes the file
- **THEN** X's chunks SHALL carry `chat_id = A`
- **AND** Y's chunks SHALL carry `chat_id = B`
- **AND** both SHALL retain `scope = "transcript/<conversationId>"`

#### Scenario: Legacy provenance is absent

- **WHEN** a legacy transcript entry has no provable `sourceSurfaceId`
- **THEN** its chunks SHALL be indexed with `chat_id = null`
- **AND** the indexer SHALL not substitute the Conversation's current binding

### Requirement: Indexed transcript rows retain source Surface provenance

The memory database SHALL add nullable `source_surface_id` to `memory_entries`. Transcript chunks with valid event-time provenance SHALL store the canonical SurfaceId in that column; curated memory/user rows and legacy, invalid, or internal transcript chunks SHALL store null. The existing `chat_id` SHALL remain the indexed chat-filter column and SHALL be derived from `source_surface_id`, never treated as the richer authority. FTS rows need not duplicate `source_surface_id` because ranked results join back to `memory_entries`.

Dreaming and provenance diagnostics SHALL read the stored SurfaceId through the canonical codec. Search results need not expose it in the public tool schema in this change.

#### Scenario: Provenance-bearing chunk is persisted

- **WHEN** an entry from topic Surface X is chunked and indexed
- **THEN** each chunk row SHALL store X's canonical ID in `source_surface_id`
- **AND** SHALL store X's decoded chat ID in `chat_id`

#### Scenario: Curated rows remain Surface-free

- **WHEN** a curated memory or user entry is inserted
- **THEN** `source_surface_id` SHALL be null

### Requirement: Provenance rollout invalidates guessed transcript rows

Before provenance-aware transcript search is enabled, startup SHALL first pass the filesystem `stateVersion` gate proving the offline transcript migration completed, then atomically invalidate every previously indexed transcript row whose `chat_id` came from session-level metadata. The SQLite invalidation transaction SHALL remove transcript rows and their FTS, embedding, tag, and source-tracking rows and SHALL update the provenance-index version as its final statement, becoming visible atomically when the transaction commits. Normal bounded transcript sync SHALL then rebuild rows from per-entry provenance. Search MUST NOT expose old guessed `chat_id` rows during the transactional database upgrade or rebuild.

#### Scenario: Existing index is upgraded

- **GIVEN** the database contains transcript rows indexed under the old session-level chat rule
- **WHEN** the provenance migration completes
- **THEN** one SQLite transaction SHALL remove those transcript rows and dependent index data and mark the new index version
- **AND** subsequent sync SHALL rebuild them from entry provenance

#### Scenario: Process stops during index invalidation

- **WHEN** the process stops before the SQLite invalidation transaction commits
- **THEN** the transaction SHALL roll back without recording the provenance-index version
- **AND** the next startup SHALL repeat the database upgrade before search, scheduler, or polling begins

## MODIFIED Requirements

### Requirement: Memory search defaults to current chat scopes

Memory search SHALL preserve the captured-context caller visibility, corpus selection, and `all_chats` behavior established by `surface-derived-memory-context`. For Surface-backed callers, transcript filtering SHALL compare the capture's `ActiveScope.chatId` against each chunk's provenance-derived `chat_id`. Provenance-null chunks and chunks from other chats SHALL be excluded by default. `all_chats = true` SHALL include every transcript chat plus provenance-null legacy chunks. Explicit internal transcript search SHALL continue to include all chats without constructing a Surface.

#### Scenario: Same-chat provenance is included

- **WHEN** a caller in chat A searches the default corpus
- **THEN** transcript chunks whose source Surface decoded to chat A SHALL be eligible
- **AND** chunks from chat B or with `chat_id = null` SHALL be excluded

#### Scenario: Cross-chat opt-in includes unresolved legacy chunks

- **WHEN** `all_chats = true` is supplied
- **THEN** transcript chunks from every chat and provenance-null legacy chunks SHALL be eligible

### Requirement: Session transcript indexing with delta sync

The system SHALL continue delta-syncing non-internal Conversation transcript files into `memory_entries` with `scope = "transcript/<conversationId>"` and `entry_kind = "transcript"`, preserving file hash/mtime/size tracking, bounded chunking, embedding, FTS/tag maintenance, deleted-file cleanup, result provenance, and frozen-summary exclusion.

For each parsed entry, chunking SHALL preserve its optional source Surface provenance and the indexer SHALL derive `chat_id` from that entry only. Changed files SHALL be replaced atomically at the transcript-scope index seam even when entries have mixed chats. Invalid/absent provenance SHALL yield null chat ID. Internal transcripts SHALL remain excluded from user transcript indexing by explicit internal identity, not by treating zero as a Telegram Surface.

#### Scenario: Changed mixed-Surface transcript syncs

- **WHEN** a changed transcript contains valid entries from two source Surfaces
- **THEN** all chunks SHALL replace the prior transcript-scope rows atomically
- **AND** each row SHALL carry its own provenance-derived chat ID

#### Scenario: Deleted Conversation removes indexed transcript

- **WHEN** a previously indexed Conversation transcript is removed
- **THEN** its transcript rows, embeddings, FTS rows, tags, and source record SHALL be removed as currently accepted

### Requirement: Dreaming consolidates memory on a schedule

The scheduled light, REM, and deep phases SHALL preserve the accepted extraction, confidence, quarantine, deduplication, consolidation, diary, budget, and serialization behavior. Promotion scope SHALL be selected from transcript-entry source Surface provenance rather than a session-level scope.

Light sleep SHALL partition candidate source line ranges by their projected source MemoryScope and SHALL quarantine every candidate that spans conflicting proven scopes as `ambiguous_source_scope`; no aggregation winner is selected during light sleep. REM SHALL count provenance-derived origin scopes and apply the accepted highest-origin-count, most-recent-update, then scope-name ordering. Deep sleep SHALL preserve the scope already selected for each short-term row. Missing or invalid legacy provenance SHALL contribute no invented topic scope and SHALL use decision 0025's deterministic `general` fallback when no proven scope exists. The internal extractor context SHALL remain Surface-free and SHALL not itself become a promotion target.

#### Scenario: Light sleep promotes moved history correctly

- **WHEN** light sleep processes a candidate sourced only from entries produced on topic Surface X
- **THEN** it SHALL promote to X's projected topic MemoryScope
- **AND** SHALL ignore the Conversation's current binding

#### Scenario: Ambiguous legacy promotion falls back

- **WHEN** a candidate's source entries have no provable Surface provenance
- **THEN** its memory target SHALL be `general` under decision 0025

#### Scenario: REM tie-breaking remains deterministic

- **WHEN** a recurring theme has several provenance-derived origin scopes
- **THEN** the existing highest-origin-count, most-recent-update, then scope-name ordering SHALL select its target

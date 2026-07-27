# transcript-surface-provenance — Tasks

## Phase 1: Stamp event-time transcript provenance

- [x] Verify dependency APIs provide canonical Surface codecs and immutable runtime `sourceSurfaceId` capture before changing transcript writes.
- [x] Extend `src/sessions/transcript.ts` with optional typed `sourceSurfaceId` and a required Surface/internal writer context; validate canonical Surface IDs at the seam and expose migration-only lossless raw records.
- [x] Preserve validated provenance through parsing, display extraction, range reads, logical cursor alignment, and per-entry chunking; keep malformed/unknown raw provenance readable and byte-preserved on rewrite without exposing it as typed authority.
- [x] Bind main-agent event writes to the runtime's frozen writer context and make every internal write select the explicit internal writer path.
- [x] Update intake and command-generated synthetic user-visible replies to use the current runtime's captured writer context, never a binding lookup; deliver but do not append and emit a bounded signal when no context exists.
- [x] Route every transcript JSONL read, including voice-command display lookup, through the transcript module; add transcript/agent/intake tests for all entry roles, synthetic replies, and X-to-Y movement; prove no-context delivery leaves JSONL unchanged, consults neither binding nor runtime creation, and emits bounded `no-transcript-writer-context`; cover internal omission, malformed/absent legacy values, lossless raw round trips, and chunk propagation; run focused tests and `bun run typecheck`.

## Phase 2: Migrate legacy transcript files conservatively

- [x] Implement `TranscriptProvenanceMigrator` as canonical offline filesystem step 3 after execution-environment migration and before Conversation lifecycle migration, set `CURRENT_STATE_VERSION = 3`, and use all-file precomputation plus atomic per-file replacement.
- [x] Preserve valid existing per-entry provenance, every other field, and line order; in this deployment no backfill source beyond an entry's own valid `sourceSurfaceId` exists, so legacy entries without it stay null.
- [x] Leave provenance absent when only current binding, creation metadata, shared scope/CWD, or Execution Environment is available; report bounded unknown-provenance counts without transcript content.
- [x] Fail loudly on non-`ENOENT` I/O and invalid rewrites before filesystem `stateVersion` advances; do not add an independent marker, startup execution, mixed-generation support, or partial-restart recovery.
- [x] Cover migration from filesystem version 2 to 3, exact once-only step execution, explicit evidence, invalid IDs, no-current-binding guess, successful complete output, malformed input, non-`ENOENT` failures, and unchanged order/fields.
- [x] Run focused transcript migration tests and `bun run typecheck`.

## Phase 3: Rebuild mixed-chat transcript indexing

- [x] Add nullable `memory_entries.source_surface_id` and one transactional SQLite provenance-index version marker through the idempotent memory schema migration; keep curated/user rows null and add no filesystem completion marker.
- [x] Change transcript-scope replacement to accept per-chunk SurfaceId/chat-ID values while maintaining entries, FTS, embeddings, tags, and source tracking in one transaction.
- [x] Remove session-state/file-level chat resolution from `src/memory/transcript-index.ts`; derive each chunk's `chat_id` only through `parseSurfaceId`.
- [x] Support one `transcript/<conversationId>` scope containing multiple chat IDs and null unresolved rows without changing bounded sync or deletion cleanup.
- [x] Transactionally purge all old transcript rows and dependent index/source data before setting the provenance-index version; never expose old guessed rows as current.
- [x] Preserve captured same-chat defaults, explicit `all_chats = true` access to every/null row, and explicit internal all-transcript search.
- [x] Add schema/store/index/search tests for mixed chats, null legacy rows, invalid IDs, complete purge, crash boundaries, bounded rebuild, and deleted transcripts; run focused tests and `bun run typecheck`.

## Phase 4: Make dreaming provenance-driven

- [ ] Remove session-level ActiveScope and binding/state resolution from light-sleep and scheduler entry points; pass only the Conversation/session compatibility ID.
- [ ] Resolve light-sleep memory targets from candidate line ranges: one proven scope promotes there, no proven scope falls back to `general`, and conflicting proven scopes quarantine as `ambiguous_source_scope`.
- [ ] Keep user-memory targets global and reject/quarantine internal extractor `target = agent` proposals without named caller authority.
- [ ] Make REM read canonical stored Surface provenance, count each Conversation at most once per projected scope, and preserve highest-count/latest-update/scope-name ordering.
- [ ] Preserve already-selected short-term scope through deep sleep and keep model extraction on the explicit Surface-free internal context.
- [ ] Add moved-topic, mixed-range, legacy fallback, deterministic REM, deep-preservation, and zero-chat internal tests; run dreaming/scheduler/quarantine tests and `bun run typecheck`.

## Phase 5: Gate startup and reject provenance guesses

- [ ] Keep transcript-file migration in the canonical offline runner; at startup, require the current filesystem `stateVersion`, then order transactional SQLite index invalidation → bounded initial sync → scheduler/polling.
- [ ] Add static boundary tests proving transcript indexing and dreaming do not import session state/current bindings, only the transcript module parses provenance, and only `TranscriptProvenanceMigrator` imports the migration-only lossless-record operation.
- [ ] Add an end-to-end fixture where one Conversation writes on two Surfaces, indexes each chat correctly, excludes unresolved history by default, and promotes each source to the correct scope.
- [ ] Verify migration/index/dreaming error paths emit bounded SurfaceId/Conversation/count signals without transcript content; run `bun test`, `bun run typecheck`, and `litespec validate transcript-surface-provenance --strict`.

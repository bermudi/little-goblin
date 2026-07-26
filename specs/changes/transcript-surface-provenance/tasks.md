# transcript-surface-provenance — Tasks

## Phase 1: Stamp event-time transcript provenance

- [ ] Verify dependency APIs provide canonical Surface codecs and immutable runtime `sourceSurfaceId` capture before changing transcript writes.
- [ ] Extend `src/sessions/transcript.ts` with optional `sourceSurfaceId` and a required Surface/internal writer context; validate canonical Surface IDs at the seam.
- [ ] Preserve provenance through parsing, display extraction, range reads, logical cursor alignment, and per-entry chunking without dropping other legacy fields or text.
- [ ] Bind main-agent event writes to the runtime capture and make every internal write select the explicit internal writer path.
- [ ] Update intake and command-generated synthetic user-visible replies to use the current runtime's captured writer context, never a binding lookup.
- [ ] Add transcript/agent/intake tests for all entry roles, synthetic replies, X-to-Y movement, internal omission, malformed/absent legacy values, round trips, and chunk propagation; run focused tests and `bun run typecheck`.

## Phase 2: Migrate legacy transcript files conservatively

- [ ] Implement `TranscriptProvenanceMigrator` after canonical Surface migration with all-file precomputation and atomic per-file replacement.
- [ ] Preserve valid existing provenance, every other field, and line order; backfill only when persisted historical evidence proves one canonical event source.
- [ ] Leave provenance absent when only current binding, creation metadata, shared scope/CWD, or Execution Environment is available; report bounded counts without transcript content.
- [ ] Add an idempotent file-version marker committed only after every file succeeds, with fail-loud handling for non-`ENOENT` I/O and invalid rewrites.
- [ ] Cover explicit evidence, invalid IDs, no-current-binding guess, mixed migrated/unmigrated files, interrupted replacement, marker interruption, and unchanged order/fields.
- [ ] Run focused transcript migration tests and `bun run typecheck`.

## Phase 3: Rebuild mixed-chat transcript indexing

- [ ] Add nullable `memory_entries.source_surface_id` and provenance file/index metadata through the idempotent memory schema migration; keep curated/user rows null.
- [ ] Change transcript-scope replacement to accept per-chunk SurfaceId/chat-ID values while maintaining entries, FTS, embeddings, tags, and source tracking in one transaction.
- [ ] Remove session-state/file-level chat resolution from `src/memory/transcript-index.ts`; derive each chunk's `chat_id` only through `parseSurfaceId`.
- [ ] Support one `transcript/<conversationId>` scope containing multiple chat IDs and null unresolved rows without changing bounded sync or deletion cleanup.
- [ ] Transactionally purge all old transcript rows and dependent index/source data before setting the provenance-index version; never expose old guessed rows as current.
- [ ] Preserve captured same-chat defaults, explicit `all_chats = true` access to every/null row, and explicit internal all-transcript search.
- [ ] Add schema/store/index/search tests for mixed chats, null legacy rows, invalid IDs, complete purge, crash boundaries, bounded rebuild, and deleted transcripts; run focused tests and `bun run typecheck`.

## Phase 4: Make dreaming provenance-driven

- [ ] Remove session-level ActiveScope and binding/state resolution from light-sleep and scheduler entry points; pass only the Conversation/session compatibility ID.
- [ ] Resolve light-sleep memory targets from candidate line ranges: one proven scope promotes there, no proven scope falls back to `general`, and conflicting proven scopes quarantine as `ambiguous_source_scope`.
- [ ] Keep user-memory targets global and reject/quarantine internal extractor `target = agent` proposals without named caller authority.
- [ ] Make REM read canonical stored Surface provenance, count each Conversation at most once per projected scope, and preserve highest-count/latest-update/scope-name ordering.
- [ ] Preserve already-selected short-term scope through deep sleep and keep model extraction on the explicit Surface-free internal context.
- [ ] Add moved-topic, mixed-range, legacy fallback, deterministic REM, deep-preservation, and zero-chat internal tests; run dreaming/scheduler/quarantine tests and `bun run typecheck`.

## Phase 5: Gate startup and reject provenance guesses

- [ ] Order startup as Surface migration → transcript file migration → index invalidation → bounded initial sync → scheduler/polling, with idempotent recovery at every boundary.
- [ ] Add static boundary tests proving transcript indexing and dreaming do not import session state/current bindings and only the transcript module parses provenance.
- [ ] Add an end-to-end fixture where one Conversation writes on two Surfaces, indexes each chat correctly, excludes unresolved history by default, and promotes each source to the correct scope.
- [ ] Verify migration/index/dreaming error paths emit bounded SurfaceId/Conversation/count signals without transcript content; run `bun test`, `bun run typecheck`, and `litespec validate transcript-surface-provenance --strict`.

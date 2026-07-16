# memory-engine — Tasks

## Phase 0: Source material and cross-cutting decisions

- [ ] Vendor the OpenClaw `memory-core` source files under `extensions/memory-core/` with MIT license headers. Source is at `~/build/testing/the_claws/openclaw/extensions/memory-core/`. Reference files: `src/memory/hybrid.ts`, `src/memory/mmr.ts`, `src/memory/temporal-decay.ts`, `src/concept-vocabulary.ts`, `src/memory-budget.ts`, `src/memory/manager-embedding-ops.ts` (FTS write path).
- [ ] Verify decision `0015-memory-sqlite-canonical` exists and matches: SQLite is canonical, markdown is export-only, per-write git commits are removed.
- [ ] Verify decision `0016-transcript-search-global` exists and matches: transcript search from `corpus="all"` is restricted to the current chat by default and crosses chat boundaries only when `all_chats=true`.
- [ ] Verify decision `0018-memory-database-guardrail-carveout` exists and matches: update the AGENTS.md "No database" guardrail to carve out the memory SQLite database.
- [ ] Verify decision `0020-memory-bun-sqlite` exists and matches: `bun:sqlite` builtin with pure-JS cosine similarity (not `node:sqlite` + `sqlite-vec`).
- [ ] Verify decision `0021-memory-openai-embedding-direct` exists and matches: direct `fetch()` to OpenAI embeddings API, no provider registry.
- [ ] Verify decision `0022-memory-frozen-summary` exists and matches: frozen system prompt summary at session creation, not per-turn snapshot.
- [ ] Verify decision `0023-memory-two-tools` exists and matches: `memory_search` + `memory_write` replace four tools.
- [ ] Verify decision `0024-memory-hybrid-weights` exists and matches: configurable fusion weights via env vars, defaults 0.7/0.3.
- [ ] Verify decision `0025-dream-cross-session-promotion-rule` exists and matches: REM/deep sleep promote to scope with highest session count, ties by most recent `updated_at` then scope name ascending, default `general`.
- [ ] Verify decision `0026-general-scope-shared-across-dms-and-no-topic-chats` exists and matches: `general` scope shared across all DMs and no-topic supergroup chats, no per-chat `general`.
- [ ] Verify `AGENTS.md` Guardrails section already contains the "No database except the memory store" carve-out (it does as of this writing — no edit needed unless it has drifted).
- [ ] Verify `AGENTS.md` memory section already reflects the SQLite-backed system, global budget, and `memory_write` tool actions (it does as of this writing — no edit needed unless it has drifted).
- [ ] Coordinate with `session-metrics`: ensure `MemoryStore`, `searchMemoryEntries`, and `DreamingPipeline` accept optional `MetricsStore` injection points so the metrics change can instrument memory writes, searches, and reflection without re-landing `memory-engine`.

## Phase 1: SQLite database and schema

- [ ] Create `src/memory/db.ts` — `MemoryDatabase` class wrapping `bun:sqlite`. Open/create `$GOBLIN_HOME/state/memory/memory.sqlite`, enable WAL mode, read `GOBLIN_MEMORY_VECTOR_WEIGHT`/`GOBLIN_MEMORY_TEXT_WEIGHT` (default 0.7/0.3, clamp to [0, 1]), expose `close()`.
- [ ] Create `src/memory/schema.ts` — DDL for `memory_entries` (`id TEXT PRIMARY KEY`, `scope TEXT`, `entry_kind TEXT`, `text TEXT`, `description TEXT`, `created_at INTEGER`, `updated_at INTEGER`, `source_session TEXT`, `updated_source_session TEXT`, `source_role TEXT`, `category TEXT`, `confidence REAL`, `origin TEXT`, `promoted_at INTEGER`, `chat_id TEXT` nullable), `memory_embeddings` (`entry_id TEXT PRIMARY KEY`, `provider TEXT`, `model TEXT`, `hash TEXT`, `embedding BLOB`, `dims INTEGER`, `updated_at INTEGER`), `memory_index_fts` (FTS5 **contentful** virtual table — columns: `text`, `entry_id`, `scope`, `entry_kind`, `chat_id`; stores its own copy of entry text; manually maintained via INSERT/DELETE on every mutating path, NOT external-content, NOT contentless), `memory_sources` (`path TEXT PRIMARY KEY`, `source TEXT`, `hash TEXT`, `mtime INTEGER`, `size INTEGER`, `updated_at INTEGER`), `memory_meta` (`key TEXT PRIMARY KEY`, `value TEXT`, `updated_at INTEGER`), and `memory_entry_tags` (`entry_id TEXT`, `tag TEXT`, composite primary key `(entry_id, tag)`). Use `crypto.randomUUID()` for `memory_entries.id` and collision-check on insert. Schema version check via `memory_meta`. Ensure `memory_meta` has a `reindexing` key (boolean string) that is set during a model-change reindex, cleared on completion, and reset to `"false"` on startup if found stale.
- [ ] Create `src/memory/db.test.ts` — test database creation, WAL mode, table existence, schema versioning, re-open persistence, `reindexing` flag set/clear semantics, weight parsing/clamping.
- [ ] Add `memoryDbPath` and `dreamsDir` to `src/memory/paths.ts`.
- [ ] Add concurrent read/write test for `bun:sqlite` WAL behavior; define a lock strategy if true concurrency is not available.
- [ ] Verify: `bun test src/memory/db.test.ts` passes.

## Phase 2: Markdown → SQLite migration

- [ ] Create `src/memory/migration.ts` — parse existing `user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, `agents/<name>/memory.md`, `archive/topics/<chatId>/<topicId>/memory.md`. Split on `\n§\n`. Insert each entry into `memory_entries` with `origin = "user"`, `scope`/`entry_kind` derived from the path per the mapping table (archive files map to `scope = "archive/topics/<chatId>/<topicId>"`, `entry_kind = "memory"`), `created_at`/`updated_at` from the committer date of the most recent commit touching that file (or current time if no git history). Set `memory_meta.migrated_at`.
- [ ] Create `src/memory/migration.test.ts` — test migration from a fixture directory with markdown files. Verify entries, scopes, delimiter splitting, no re-migration.
- [ ] Wire migration into `src/index.ts` startup: if `memory.sqlite` does not exist and markdown files are present, run migration before bot startup.
- [ ] Verify: `bun test src/memory/migration.test.ts` passes.

## Phase 3: SQLite-backed store

- [ ] Rewrite `src/memory/store.ts` — `MemoryStore` class backed by `MemoryDatabase` instead of markdown files. Same public interface: `add`, `replace`, `remove`, `rewrite`, `setDescription`, `read`, `readIndex`. Resolve tool `target` to database `(scope, entry_kind)` via `scope.ts`. Remove `MEMORY_CAP`/`USER_CAP` constants. Use `budget.ts` for budget enforcement (stubbed in this phase, full implementation in Phase 8). Each mutating method SHALL wrap all DB changes (`memory_entries` + `memory_index_fts` + `memory_entry_tags` + `memory_embeddings`) in a single SQLite transaction. For `replace`/`rewrite`: compute net budget change (`currentTotal - oldText.length + newText.length`) before commit; delete old FTS row, insert new FTS row. For `remove`: delete FTS row before deleting `memory_entries` row. For `set_description`: update only `description` column (no FTS, no budget check). Enforce 200-character single-line description cap in `setDescription`. Add `archiveOrphanTopic(chatId, topicId)` to prefix the scope with `archive/` on Telegram not-found errors.
- [ ] Modify `src/memory/scope.ts` — change the `ActiveScope → MemoryScope` conversion to return a `(scope, entry_kind)` pair (`MemoryScopePair` type: `{ scope: string; entry_kind: "memory" | "user" }`) instead of a `MemoryScope` with a markdown path. This is the single home for the conversion; all consumers import from here.
- [ ] Rewrite `src/memory/store.test.ts` — test CRUD against SQLite store. Verify scope resolution, entry insertion, substring match for replace/remove, description updates, orphan topic archiving (scope prefixed with `archive/` and excluded from index/search).
- [ ] Update `src/memory/entry.ts` — adapt metadata parsing for SQLite columns. `formatReflectedEntry` and `parseEntryMetadata` read from columns instead of inline comments. Legacy entries (null metadata) are preserved.
- [ ] Update `src/memory/mod.ts` — export `MemoryDatabase`, update `MemoryStore` export.
- [ ] Verify: `bun test src/memory/store.test.ts` passes. Existing callers (`tool.ts`, `snapshot.ts`, `reflector.ts`) still compile with the new store (they will be rewritten in later phases).

## Phase 4: Embedding provider

- [ ] Create `src/memory/embeddings.ts` — `EmbeddingProvider` class. `embedQuery(text)`, `embedBatch(texts[])` via OpenAI `fetch()`. Read API key from `GOBLIN_MEMORY_EMBEDDING_API_KEY` (fallback `OPENAI_API_KEY`); optional base URL from `GOBLIN_MEMORY_EMBEDDING_BASE_URL` (fallback `OPENAI_BASE_URL`). Cache by text hash in `memory_embeddings` table. Detect model changes via `memory_meta.embedding_model` and trigger reindex. FTS-only fallback with a 60s cooldown. Configurable model via `GOBLIN_MEMORY_EMBEDDING_MODEL`.
- [ ] Create `src/memory/embeddings.test.ts` — test embedding, cache hit/miss, fallback state transitions, model change detection, batch embedding.
- [ ] Verify: `bun test src/memory/embeddings.test.ts` passes.

## Phase 5: Concept vocabulary

- [ ] Create `src/memory/concept-vocabulary.ts` — port from `extensions/memory-core/src/concept-vocabulary.ts`. Inline the `string-coerce-runtime` import (it is a one-line `normalizeLowercaseStringOrEmpty`). Include stop words, glossary, compound token detection, `Intl.Segmenter` segmentation, script classification.
- [ ] Create `src/memory/concept-vocabulary.test.ts` — port tests from `extensions/memory-core/src/concept-vocabulary.test.ts`. Test tag extraction, stop word filtering, CJK segmentation, glossary bypass, script classification.
- [ ] Wire tag extraction into `store.ts` — on `add`/`replace`/`rewrite`, compute tags via `deriveConceptTags` and insert into `memory_entry_tags`.
- [ ] Verify: `bun test src/memory/concept-vocabulary.test.ts` passes.

## Phase 6: Hybrid search

- [ ] Create `src/memory/hybrid.ts` — port `mergeHybridResults`, `buildFtsQuery`, `bm25RankToScore` from `extensions/memory-core/src/memory/hybrid.ts`. Port MMR from `mmr.ts` (Jaccard similarity, min-max normalization, lambda=0.7) and temporal decay from `temporal-decay.ts` (`exp(-ln(2) * ageInDays / halfLifeDays)`, half-life=30). Add concept tag boost: `conceptBoost = min(0.1 * matchingTagCount, 0.3)` added to fused score before decay. Inline all imports. ~350 lines total. Accept `vectorWeight`/`textWeight` (default 0.7/0.3, clamped [0, 1]) from the caller.
- [ ] Rewrite `src/memory/search.ts` — `searchMemoryEntries` now uses hybrid search: embed query via `embeddings.ts`, run vector search (cosine on `memory_embeddings`) and lexical search (BM25 on `memory_index_fts`), fuse via `hybrid.ts`. Apply concept tag boost, temporal decay, MMR. Return ranked results with `source` field (`memory` or `transcript`).
- [ ] Create `src/memory/hybrid.test.ts` — test fusion scoring, MMR diversity, temporal decay, FTS-only fallback ranking, configurable vector/text weights. Include CJK segmentation, compound token, glossary bypass, and stop-word fixtures.
- [ ] Rewrite `src/memory/search.test.ts` — test hybrid search against a populated SQLite database. Verify semantic match, lexical boost, corpus restriction, scope filtering, limit clamping, transcript chat boundary, `all_chats` behavior.
- [ ] Add reindex path: when `GOBLIN_MEMORY_EMBEDDING_MODEL` differs from `memory_meta.embedding_model`, recompute all embeddings.
- [ ] Verify: `bun test src/memory/search.test.ts` and `bun test src/memory/hybrid.test.ts` pass.

## Phase 7: Memory tools (4 → 2 merge)

- [ ] Rewrite `src/memory/tool.ts` — remove `createMemoryReadTool` and `createMemoryReadIndexTool`. Modify `createMemorySearchTool` to accept optional `query`, `scope`, `corpus`, `all_chats` parameters. Without query + with scope → return entries (replaces read). Without query + without scope → return index (replaces read_index). Modify `createMemoryWriteTool` to resolve tool `target` to database `(scope, entry_kind)` and use SQLite-backed store. Enforce 200-character single-line description cap.
- [ ] Rewrite `src/memory/tool.test.ts` — test the 2-tool interface. Verify search with query, search without query + scope, search without query + without scope, write operations, corpus restriction, `all_chats` transcript boundary, empty/whitespace query rejection, over-length description rejection.
- [ ] Update `src/agent/mod.ts` — change memory tool registration from 4 tools to 2. Remove `createMemoryReadTool` and `createMemoryReadIndexTool` imports.
- [ ] Update `src/subagents/execution.ts` — same tool registration change for subagent context.
- [ ] Verify: `bun test src/memory/tool.test.ts` passes. `bun run typecheck` passes.

## Phase 8: Budget management

- [ ] Create `src/memory/budget.ts` — auto-compaction. Count total chars across `memory_entries.text` (only `text`, not `description`) with `entry_kind = "memory"` or `entry_kind = "user"`. Drop oldest `origin = "dreaming"` entries first (ascending `promoted_at`, ties by `created_at` ascending). Preserve `origin = "user"` entries unconditionally. For `add`: check after insert. For `replace`/`rewrite`: compute net change (`currentTotal - oldText.length + newText.length`) before commit. For `set_description`: no budget check.
- [ ] Create `src/memory/budget.test.ts` — test compaction: promotion within budget, promotion triggers compaction, user entries preserved, all dreaming dropped and still over budget → fail, `replace`/`rewrite` net growth over budget → fail (original entry unchanged), `set_description` at budget boundary → succeeds (description not counted).
- [ ] Wire budget check into `store.ts` `add`/`replace`/`rewrite` — for `add`: after insert, check budget, compact if over, fail if still over. For `replace`/`rewrite`: compute net change before commit, compact if over, fail if still over (roll back transaction, original entry unchanged).
- [ ] Verify: `bun test src/memory/budget.test.ts` passes.

## Phase 9: Frozen summary and relevant memory

- [ ] Rewrite `src/memory/snapshot.ts` — replace `formatSnapshot` with `formatFrozenSummary` (bounded summary for system prompt, max 1200 chars total: header + guardrail text + active scope description + user.md summary + active scope memory summary + cross-scope index; trim index first, then summaries at word boundaries if over budget) and `formatRelevantMemory` (hybrid search on prompt text with `corpus = "memory"`, up to 3 results by default, max 5, deduplicate against frozen summary; transcript entries are excluded).
- [ ] Rewrite `src/memory/snapshot.test.ts` — test frozen summary construction, bounding, empty memory case, over-budget trimming, guardrail text presence when memory is non-empty, and omission when empty. Test `formatRelevantMemory` uses `corpus = "memory"`, excludes transcript entries, deduplicates against frozen summary, and respects 3/5 limit behavior.
- [ ] Update `src/agent/mod.ts` — add frozen summary to `_baseSystemPrompt` at session creation. Replace per-turn `formatSnapshot` + `sendCustomMessage` with `formatRelevantMemory` + `sendCustomMessage`.
- [ ] Update `src/subagents/execution.ts` — same snapshot changes for subagent context.
- [ ] Verify: `bun test src/memory/snapshot.test.ts` passes. `bun run typecheck` passes.

## Phase 10: Session transcript indexing

- [ ] Add `chunkTranscriptEntry(entry, maxChars)` to `src/sessions/transcript.ts` — takes a `TranscriptEntry`, returns bounded text snippets (max 500 chars, word-boundary truncation). Skip entries with <8 chars displayable text. Skip tool-result entries with no displayable text. Each snippet includes timestamp, role, session ID.
- [ ] Create `src/memory/transcript-index.ts` — `TranscriptIndexer` class. `sync()` method: scan `state/sessions/*/transcript.jsonl`, compare path/mtime/size/hash against `memory_sources`, reindex changed files (chunk + embed + insert into `memory_entries` + insert FTS rows into `memory_index_fts` within the same transaction, with `scope = "transcript/<sessionId>"`, `entry_kind = "transcript"`, and `chat_id` resolved by reading `state/sessions/<sessionId>/state.json` and extracting the `chatId` from the persisted `ChatLocator` binding). Remove entries, FTS rows, tag rows, embeddings, and `memory_sources` rows for deleted sessions within a single transaction per session.
- [ ] Create `src/memory/transcript-index.test.ts` — test delta sync: new file indexed, unchanged file skipped, changed file reindexed, deleted session entries and `memory_sources` row removed, hash change detection, `chat_id` resolved from `state.json` binding and used for chat-scoped search.
- [ ] Verify: `bun test src/memory/transcript-index.test.ts` passes.

## Phase 11: Dreaming pipeline

- [ ] Create `src/memory/dreaming.ts` — `DreamingPipeline` class with `runLightSleep()`, `runRemSleep()`, `runDeepSleep()` methods. Light sleep: read transcript after cursor, filtered to the lookback window (default 24 hours; effective range is `max(cursor, now − lookback)` to `now`), spawn extraction subagent that returns JSON candidates (`text`, `category`, `confidence`, `target`, `rationale`). Parse the subagent response by extracting the first fenced JSON code block; quarantine malformed output. Filter `category = "skip"` or candidates below the confidence threshold and quarantine with reason `low_confidence`. Dedupe via cosine similarity (threshold 0.85); near-duplicates update the existing entry (preserve `created_at`/`source_session`, refresh `updated_at`/`updated_source_session`) rather than inserting a new row. Promote novel candidates with `origin = "dreaming"` and `promoted_at` set. On first observation of a session: if `memory-reflection.json` exists, migrate its cursor value to the dreaming cursor format (same line offset) and remove/supersede the old file; if no cursor file exists, seed cursor to transcript end (no backfill). REM sleep: aggregate concept tags across distinct sessions, detect recurring themes, promote to the scope with the most frequent origin session (ties by most recent `updated_at`, then scope name ascending; default `general`). Deep sleep: promote short-term entries to durable, update `promoted_at`, run budget compaction, update dream diary. Dispatch to internal session `__goblin_dreaming__`.
- [ ] Create `src/memory/dreaming-narrative.ts` — optional narrative diary generation via subagent. Off by default (`GOBLIN_MEMORY_DREAM_NARRATIVE=true` to enable).
- [ ] Extend `src/memory/quarantine.ts` — add `"malformed"` to the `QuarantineReason` union type. The existing `low_confidence` reason is already present. No other changes to the record shape or write path.
- [ ] Create `src/memory/dreaming.test.ts` — test light sleep extraction and promotion, REM theme detection and scope selection, deep sleep promotion and compaction, dedup via cosine similarity and consolidation of existing entries, cursor advancement, cursor migration from existing `memory-reflection.json` (value preserved, old file superseded), cursor seeding for cursorless sessions (no backfill), dream diary writing, standing_order extraction, malformed subagent output quarantine, `skip`/low-confidence candidate quarantine with reason `low_confidence`.
- [ ] Remove `src/memory/reflector.ts` and `src/memory/reflector.test.ts`.
- [ ] Update `src/agent/mod.ts` — replace `memoryReflector` field with `dreamingPipeline`. On `agent_end`, advance the reflection cursor instead of scheduling reflection.
- [ ] Verify: `bun test src/memory/dreaming.test.ts` passes. `bun run typecheck` passes.

## Phase 12: Scheduler integration

- [ ] Update `src/scheduler/loop.ts` — add dreaming phase schedules (light/REM/deep, minute intervals or `off`, defaults 240/1440/1440) and transcript sync schedule (5 minutes) at startup. Add `memoryEngine` dependency (a single `MemoryEngine` bundle object wrapping `MemoryDatabase` + `DreamingPipeline` + `TranscriptIndexer`) to `SchedulerLoop` constructor. For REM and deep sleep, align the first dispatch to the configured local time (03:00 / 04:00) by computing the next occurrence after startup; subsequent dispatches spaced by the interval. Light sleep starts from the first tick after startup. Dispatch dreaming turns to internal session `__goblin_dreaming__`. Dispatch transcript sync as a lightweight task (not a full agent turn) that yields between files and is bounded to 30 seconds per tick. Coalesce overlapping dreaming phases.
- [ ] Update `src/index.ts` — construct `MemoryDatabase`, `DreamingPipeline`, `TranscriptIndexer`. Pass to `SchedulerLoop` and `AgentRunner`. Register dreaming schedules.
- [ ] Update scheduler tests — verify dreaming schedule registration, dispatch, coalescing, and transcript sync tick.
- [ ] Verify: `bun test` passes (full suite). `bun run typecheck` passes.

## Phase 13: CLI and export

- [ ] Create `src/memory/export.ts` — `exportToMarkdown(db)` function. Writes entries with `entry_kind = "memory"` or `entry_kind = "user"` back to markdown files in the existing directory structure per the mapping table (`user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, `agents/<name>/memory.md`). Entries with `entry_kind = "transcript"` or `scope` prefixed with `archive/` are not exported. Atomic writes (tmp + rename).
- [ ] Create `src/memory/cli.ts` (new file) — shell-level CLI entry point. `memory export` calls `exportToMarkdown`. `memory status` shows database size, entry count, embedding provider status, last sync time. `memory search <query>` uses hybrid search. Invoked via `bun run src/memory/cli.ts <command> [args]`. There is no existing `memory` CLI to update; this is a new command surface.
- [ ] Verify: `memory export` produces markdown files matching the SQLite store. `memory status` reports correct counts.

## Phase 14: End-to-end verification

- [ ] Run full test suite: `bun test`.
- [ ] Run typecheck: `bun run typecheck`.
- [ ] Manual smoke test: start goblin, send a message, verify `memory.sqlite` is created, verify `memory_search` returns results, verify frozen summary appears in system prompt with the guardrail text, verify `## relevant memory` appears in per-turn aside and never contains transcript entries.
- [ ] Verify migration: create markdown files, start goblin, verify entries are migrated to SQLite.
- [ ] Verify export: run `memory export`, verify markdown files match SQLite contents.
- [ ] Update canon `specs/canon/memory/spec.md` and `specs/canon/agent/spec.md` to reflect the two-tool interface and frozen summary behavior (or open a follow-up canon rewrite change).

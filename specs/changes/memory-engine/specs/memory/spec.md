# memory

## ADDED Requirements

### Requirement: SQLite-backed memory store

The system SHALL maintain a SQLite database at `$GOBLIN_HOME/state/memory/memory.sqlite` as the canonical store for all memory entries. The database SHALL contain the following tables:

- `memory_entries` — one row per entry. Columns: `id` (text primary key), `scope` (text), `entry_kind` (text: `memory`, `user`, `transcript`), `text` (text: entry body), `created_at` (integer: unix ms), `updated_at` (integer: unix ms), `source_session` (text nullable), `updated_source_session` (text nullable), `source_role` (text nullable), `category` (text nullable), `confidence` (real nullable), `origin` (text: `user` or `dreaming`), `promoted_at` (integer nullable: unix ms, set when origin=dreaming), `chat_id` (text nullable: the Telegram chat id for transcript entries, used for chat-scoped search filtering; null for `memory` and `user` entries), `recall_count` (integer NOT NULL DEFAULT 0: incremented by `memory_search` when this entry is returned in results), `last_recalled_at` (integer nullable: unix ms of the most recent `memory_search` return). The `description` column is NOT on this table — per-scope descriptions live in `memory_scopes` (see decision `0028-memory-scopes-table`).
- `memory_scopes` — per-scope metadata normalization. Columns: `scope` (text primary key), `description` (text nullable: one-line scope description, ≤ 200 characters), `updated_at` (integer: unix ms). A row exists for each scope that has had a `set_description` call or a migrated frontmatter description. Scopes with no description have no row (or a row with `description = NULL`). This table is independent of `memory_entries` — `set_description` on an empty scope (zero entries) SHALL succeed and persist the description.
- `memory_embeddings` — one row per embedded entry. Columns: `entry_id` (text primary key and foreign key to `memory_entries.id`), `provider` (text), `model` (text), `hash` (text: sha256 of entry text), `embedding` (blob), `dims` (integer), `updated_at` (integer).
- `memory_index_fts` — FTS5 **contentful** virtual table storing its own copy of entry text. Columns: `text` (indexed content), `entry_id` (text: logical reference to `memory_entries.id`, maintained by manual INSERT/DELETE — NOT a SQLite FK constraint, since FTS5 virtual tables cannot enforce foreign keys), `scope` (text), `entry_kind` (text), `chat_id` (text nullable). The table is NOT external-content and NOT contentless — it stores a duplicate of `memory_entries.text` in its `text` column. The system SHALL manually maintain the FTS index on every mutating path: `INSERT INTO memory_index_fts (text, entry_id, scope, entry_kind, chat_id) VALUES (?, ?, ?, ?, ?)` after each `memory_entries` insert; `DELETE FROM memory_index_fts WHERE entry_id = ?` before each `memory_entries` deletion (compaction, session removal, `remove`/`rewrite` of an existing entry). On `replace`/`rewrite`, the system SHALL delete the old FTS row and insert the new one within the same transaction. All FTS maintenance SHALL occur inside the same SQLite transaction as the corresponding `memory_entries` mutation.
- `memory_sources` — transcript file sync tracking. Columns: `path` (text primary key), `source` (text: `transcript`), `hash` (text nullable), `mtime` (integer), `size` (integer), `updated_at` (integer). `hash` is populated for transcript files and used to detect content changes not visible in mtime/size.
- `memory_meta` — key-value store. Columns: `key` (text primary key), `value` (text), `updated_at` (integer: unix ms). Required keys: `schema_version`, `migrated_at`, `embedding_provider`, `embedding_model`, `reindexing`. The `reindexing` key SHALL be set to `"true"` while a model-change or full reindex is in progress and SHALL be cleared to `"false"` on completion. It SHALL be checked on startup to prevent concurrent reindex passes. On startup, if `reindexing = "true"` and no reindex process is actively running (single-process: no concurrent process can be running), the system SHALL reset it to `"false"` to recover from a previous crash that left the flag set. While `reindexing = "true"`, `memory_search` SHALL continue to use existing (potentially stale) embeddings for vector search — search SHALL NOT block or degrade to FTS-only during reindex. The worst case is a transient ranking inconsistency during the reindex window.
- `memory_entry_tags` — concept vocabulary tags. Columns: `entry_id` (text, foreign key to `memory_entries.id`), `tag` (text). Composite primary key `(entry_id, tag)`. Populated on write and recomputed when entry text changes. Limited to 8 tags per entry.

`id` values SHALL be generated as Type-4 UUIDs (`crypto.randomUUID()`) and SHALL be collision-checked on insert.

All writes SHALL use atomic SQLite transactions. The database SHALL use WAL journal mode. The `bun:sqlite` builtin SHALL be used for all database access — no external SQLite bindings.

The system SHALL support the following `(scope, entry_kind)` combinations:

| Legacy markdown path | `scope` | `entry_kind` | `memory_write` tool `target` | Notes |
| --- | --- | --- | --- | --- |
| `user.md` | `user` | `user` | `user` | Global user identity. |
| `general/memory.md` | `general` | `memory` | `memory` in a DM / no-topic chat | Catch-all. |
| `topics/<chatId>/<topicId>/memory.md` | `topics/<chatId>/<topicId>` | `memory` | `memory` in that topic | Per-topic curated memory. |
| `agents/<name>/memory.md` | `agents/<name>` | `memory` | `agent` | Named-agent persona memory. |
| `archive/topics/<chatId>/<topicId>/memory.md` | `archive/topics/<chatId>/<topicId>` | `memory` | — | Orphaned topic scope. Excluded from search and index. |
| `transcript.jsonl` (per session) | `transcript/<sessionId>` | `transcript` | — | Chunked transcript snippets, not exported to markdown. |

The `memory_write` tool parameter `target` is a tool-level directive that resolves to a database `(scope, entry_kind)` pair; it is never stored literally in the `entry_kind` column. In particular, `target="agent"` resolves to `scope="agents/<name>"` and `entry_kind="memory"`.

#### Scenario: First write creates the database

- **WHEN** `memory_write` is called and `$GOBLIN_HOME/state/memory/memory.sqlite` does not exist
- **THEN** the database SHALL be created with all tables
- **AND** WAL journal mode SHALL be enabled
- **AND** the entry SHALL be inserted into `memory_entries`

#### Scenario: Newly inserted entry appears in BM25 search

- **WHEN** `memory_write({action: "add", target: "memory", content: "the backup script broke"})` is called and the entry is inserted into `memory_entries`
- **THEN** a corresponding row SHALL be inserted into `memory_index_fts` with the same text within the same transaction
- **AND** a subsequent `memory_search({query: "backup"})` SHALL return the entry in BM25 results without requiring a reindex

#### Scenario: Removed entry disappears from BM25 search

- **WHEN** an entry is removed from `memory_entries` (via `remove`, compaction, or session deletion)
- **THEN** the corresponding row SHALL be deleted from `memory_index_fts` within the same transaction
- **AND** a subsequent `memory_search` SHALL NOT return the removed entry in BM25 results

#### Scenario: Existing markdown entries are migrated on first startup

- **WHEN** goblin starts and `memory.sqlite` does not exist but `state/memory/` contains markdown files (`user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, `agents/<name>/memory.md`, `archive/topics/<chatId>/<topicId>/memory.md`)
- **THEN** the migration SHALL parse each markdown file, split on `\n§\n`, and insert each entry into `memory_entries` with `origin = "user"`, `scope` and `entry_kind` derived from the file path per the mapping table (archive files map to `scope = "archive/topics/<chatId>/<topicId>"`, `entry_kind = "memory"`), and `created_at`/`updated_at` set to the committer date of the most recent commit touching that file (or current time if no git history or no git repo)
- **AND** the markdown files SHALL be preserved on disk as read-only export artifacts
- **AND** a `memory_meta` key `migrated_at` SHALL record the migration timestamp

#### Scenario: Markdown export reflects SQLite state

- **WHEN** the `memory export` CLI command is run
- **THEN** entries with `entry_kind` of `memory` or `user` SHALL be written back to markdown files in the existing directory structure per the mapping table
- **AND** entries with `entry_kind` of `transcript` or `scope` prefixed with `archive/` SHALL NOT be exported to markdown
- **AND** each scope's entries SHALL be joined with `\n§\n` delimiters
- **AND** files SHALL use atomic write (tmp + rename)

### Requirement: Embedding provider with caching and fallback

The system SHALL embed memory entries and transcript chunks using OpenAI's embedding API (default model: `text-embedding-3-small`). Embeddings SHALL be cached in the `memory_embeddings` table by text hash. An entry SHALL be re-embedded only when its text hash changes or the configured embedding model changes.

The embedding provider SHALL be constructed eagerly at startup (in `src/index.ts`) as part of the `MemoryEngine` bundle, so that configuration errors (missing API key, invalid base URL) surface immediately rather than on first search. If the embedding API is unavailable at runtime (network error, rate limit, auth failure), the system SHALL degrade to FTS-only search and log a warning. The degraded state SHALL be retried on the next search attempt after a configurable cooldown (default 60 seconds, configurable via `GOBLIN_MEMORY_EMBEDDING_COOLDOWN_SECONDS`).

The embedding API key SHALL be read from `GOBLIN_MEMORY_EMBEDDING_API_KEY` and SHALL fall back to `OPENAI_API_KEY` for backward compatibility. The optional embedding base URL SHALL be read from `GOBLIN_MEMORY_EMBEDDING_BASE_URL` and SHALL fall back to `OPENAI_BASE_URL`. These credentials SHALL be independent of the chat provider configuration. The embedding model SHALL be configurable via `GOBLIN_MEMORY_EMBEDDING_MODEL` (default `text-embedding-3-small`).

#### Scenario: Entry write triggers embedding

- **WHEN** a new entry is added to `memory_entries`
- **THEN** the entry text SHALL be embedded via the configured provider
- **AND** the embedding SHALL be stored in `memory_embeddings` with the current provider and model

#### Scenario: Unchanged entry skips re-embedding

- **WHEN** an entry's text hash matches the stored hash in `memory_embeddings`
- **THEN** the embedding SHALL NOT be recomputed
- **AND** the existing embedding SHALL be used for search

#### Scenario: Embedding API failure degrades to FTS-only

- **WHEN** the embedding provider returns an error (rate limit, network, auth)
- **THEN** search SHALL fall back to BM25-only ranking
- **AND** a warning SHALL be logged
- **AND** the degraded state SHALL persist for the cooldown period
- **AND** after the cooldown, the next search SHALL retry the embedding provider

### Requirement: Hybrid search with vector and lexical fusion

The system SHALL provide hybrid search over memory entries and transcript chunks. Search SHALL combine:

1. **Vector search:** cosine similarity between the query embedding and stored embeddings.
2. **Lexical search:** BM25 ranking via FTS5 on entry/chunk text.
3. **Concept tag boost:** entries matching concept tags derived from the query receive a score boost.

Results SHALL be fused with weighted scoring: `score = vectorWeight * vectorScore + textWeight * textScore + conceptBoost`. Default weights SHALL be `vectorWeight = 0.7`, `textWeight = 0.3`. Weights SHALL be configurable via the environment variables `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT` and SHALL be clamped to the range `[0, 1]`.

**BM25 score normalization:** The raw FTS5 `bm25()` rank SHALL be converted to a `[0, 1]` score via: `textScore = 1 / (1 + rank)` for non-negative ranks, and `textScore = relevance / (1 + relevance)` where `relevance = -rank` for negative ranks (which indicate higher relevance). Non-finite ranks SHALL map to `1 / (1 + 999)`.

**Concept tag boost:** After fusion, entries whose `memory_entry_tags` intersect with concept tags derived from the query SHALL receive an additive boost: `conceptBoost = min(0.1 * matchingTagCount, 0.3)`. Entries with no matching tags receive `conceptBoost = 0`. The boost is added to the fused score before temporal decay.

**Temporal decay:** After fusion and concept boost, scores SHALL be scaled by `decayedScore = score * exp(-lambda * ageInDays)` where `lambda = ln(2) / halfLifeDays` (equivalently `score * 0.5^(ageInDays / halfLifeDays)`). `ageInDays` is computed from `memory_entries.updated_at` relative to the current time. The half-life SHALL default to 30 days and SHALL be configurable via `GOBLIN_MEMORY_TEMPORAL_HALFLIFE_DAYS`. Entries with no resolvable timestamp SHALL receive no decay (multiplier 1.0).

**MMR re-ranking:** After temporal decay, results SHALL be re-ranked with MMR (Maximal Marginal Relevance) when the number of results exceeds the requested limit by a factor of 2. MMR scores SHALL be normalized to `[0, 1]` via min-max normalization across the candidate set. The MMR selection score SHALL be `mmrScore = lambda * normalizedRelevance - (1 - lambda) * maxJaccardSimilarity`, where `maxJaccardSimilarity` is the maximum Jaccard similarity (on tokenized entry text) between the candidate and any already-selected item. The lambda parameter SHALL default to 0.7. Selection is iterative: the highest-decayed-score item is selected first, then each subsequent slot maximizes `mmrScore`. Ties SHALL be broken by the original decayed score (higher wins).

#### Scenario: Semantic match ranks above lexical non-match

- **WHEN** `memory_search({query: "glacier archive failure"})` is called and an entry contains "the backup script broke" with a high cosine similarity
- **THEN** that entry SHALL appear in results despite zero lexical token overlap
- **AND** the result SHALL include the vector score

#### Scenario: Lexical match boosts semantic result

- **WHEN** an entry has both high cosine similarity and high BM25 score for a query
- **THEN** the fused score SHALL be higher than either component alone
- **AND** the entry SHALL rank above entries with only one strong signal

#### Scenario: FTS-only fallback returns lexical results

- **GIVEN** the embedding provider is in degraded state
- **WHEN** `memory_search({query: "backups"})` is called
- **THEN** results SHALL be ranked by BM25 only
- **AND** no vector scores SHALL be present in results
- **AND** a warning indicator SHALL be included in the response

#### Scenario: Temporal decay down-weights stale entries

- **GIVEN** two entries with identical fusion scores, one updated 1 day ago and one updated 60 days ago
- **WHEN** search returns both
- **THEN** the recent entry SHALL rank above the stale entry
- **AND** the stale entry's decayed score SHALL be lower than its raw fusion score

### Requirement: Search tracks recall for budget compaction

`memory_search` SHALL increment `recall_count` and update `last_recalled_at` on every returned `memory_entries` row (entries with `entry_kind = "memory"` or `entry_kind = "user"`). Transcript entries (`entry_kind = "transcript"`) SHALL NOT have their recall counters updated — transcript snippets are not subject to budget compaction.

The recall update SHALL occur after results are finalized and returned to the caller. It SHALL be a cheap follow-up write (a single `UPDATE ... WHERE entry_id IN (...)` statement). The recall update SHALL NOT block the search response — if the update fails, the search results SHALL still be returned.

The `recall_count` and `last_recalled_at` columns provide a quality signal for budget compaction (see "Budget management with recall-aware auto-compaction" and decision `0027-dreaming-model-driven-promotion`). Entries that are never returned by any search are the first to be evicted during compaction.

#### Scenario: Search increments recall_count on returned entries

- **GIVEN** `memory_entries` contains entry E1 with `recall_count = 0` and `last_recalled_at = NULL`
- **WHEN** `memory_search({query: "..."})` returns E1 in its results
- **THEN** E1's `recall_count` SHALL be incremented to 1
- **AND** E1's `last_recalled_at` SHALL be set to the current time

#### Scenario: Search does not update transcript recall counters

- **GIVEN** `memory_entries` contains a transcript entry T1 with `recall_count = 0`
- **WHEN** `memory_search({query: "...", corpus: "all"})` returns T1 in its results
- **THEN** T1's `recall_count` SHALL remain 0
- **AND** T1's `last_recalled_at` SHALL remain NULL

#### Scenario: Recall update failure does not block search

- **GIVEN** `memory_search` returns 5 results
- **WHEN** the recall update write fails (e.g. disk error)
- **THEN** the 5 search results SHALL still be returned to the caller
- **AND** the failure SHALL be logged as a warning

### Requirement: Concept vocabulary tagging

The system SHALL extract concept tags from memory entries and search queries using a multi-language tokenizer. Tags SHALL be stored alongside entries and used as a search boost signal.

Tag extraction SHALL:
- Normalize text to NFKC and lowercase.
- Tokenize using `Intl.Segmenter` (word granularity) with fallback to regex splitting.
- Detect compound tokens (`foo-bar`, `foo.bar`, `foo_bar`).
- Filter stop words in English, Spanish, French, German, and CJK.
- Match a protected glossary of technical terms that bypass length minimums. The glossary SHALL include at minimum: `backup`, `backups`, `embedding`, `embeddings`, `failover`, `gateway`, `glacier`, `gpt`, `kv`, `network`, `openai`, `qmd`, `router`, `s3`, `vlan`, plus translations: `sauvegarde`, `routeur`, `passerelle` (French); `konfiguration`, `sicherung`, `überwachung` (German); `configuración`, `respaldo`, `enrutador`, `puerta-de-enlace` (Spanish); `バックアップ`, `フェイルオーバー`, `ルーター`, `ネットワーク`, `ゲートウェイ`, `障害対応` (Japanese); `路由器`, `备份`, `故障转移`, `网络`, `网关` (Chinese); `라우터`, `백업`, `페일오버`, `네트워크`, `게이트웨이`, `장애대응` (Korean). Glossary entries shorter than the per-script minimum length SHALL use whole-word matching (delimiter-bounded) to avoid firing inside longer words (e.g. "kv" must not match inside "mkv").
- Classify script family (Latin, Han, Hiragana, Katakana, Hangul) and apply per-script minimum token lengths: Latin minimum 3 characters, CJK (Han/Hiragana/Katakana/Hangul) minimum 2 characters. Kana-only tokens shorter than 3 characters SHALL be filtered.
- Limit to 8 tags per entry.

Tags SHALL be computed on write and stored in a `memory_entry_tags` table (entry_id, tag). Tags SHALL be recomputed when entry text changes.

#### Scenario: Technical term tagged despite short length

- **WHEN** an entry contains "s3 bucket config" and "s3" is in the protected glossary
- **THEN** the tag "s3" SHALL be extracted despite being below the default Latin minimum length of 3
- **AND** the tag SHALL be stored in `memory_entry_tags`

#### Scenario: Stop word filtered

- **WHEN** an entry contains "the backup is running"
- **THEN** "the" and "is" SHALL NOT be tagged
- **AND** "backup" and "running" SHALL be tagged

#### Scenario: CJK text segmented correctly

- **WHEN** an entry contains "备份脚本坏了" (backup script broke)
- **THEN** tags SHALL include segmented CJK tokens meeting the minimum length of 2
- **AND** single-character CJK tokens SHALL be filtered

### Requirement: Session transcript indexing with delta sync

The system SHALL index session transcript files (`transcript.jsonl`) into the SQLite memory database for semantic search over conversation history. Transcript chunks SHALL be stored in the same `memory_entries` table with `scope = "transcript/<sessionId>"` and `entry_kind = "transcript"`. The `chat_id` column SHALL be populated with the session's Telegram chat id during indexing, enabling chat-scoped search filtering. The chat id SHALL be resolved by reading `state/sessions/<sessionId>/state.json` and extracting the `chatId` from the persisted `ChatLocator` binding. If the binding cannot be resolved, the transcript SHALL be indexed with `chat_id = null` and excluded from chat-scoped search.

Indexing SHALL be delta-based:
- The `memory_sources` table tracks each transcript file's path, hash, mtime, and size.
- On sync, the system SHALL scan `$GOBLIN_HOME/state/sessions/*/transcript.jsonl`, compare path, mtime, size, and hash against `memory_sources`, and reindex only files whose mtime, size, or hash has changed.
- Changed files SHALL be re-parsed: each `TranscriptEntry` is chunked into bounded snippets (max 500 chars, message-level granularity). Each snippet is embedded and inserted as a transcript-scope entry with `chat_id` set from the session's binding.
- Deleted session directories SHALL have their transcript entries removed from `memory_entries`, `memory_embeddings`, `memory_index_fts`, `memory_entry_tags`, and `memory_sources`.
- Sync SHALL run on startup and on a configurable interval (default 5 minutes) via the scheduler.

Search results SHALL distinguish `source: memory` from `source: transcript` in the response. Transcript results SHALL include the session ID and approximate timestamp. Transcript entries SHALL NOT appear in the frozen summary or `## relevant memory` aside.

#### Scenario: New transcript file indexed on sync

- **WHEN** a session completes a turn and `transcript.jsonl` grows
- **AND** the next sync tick runs
- **THEN** the new transcript entries SHALL be chunked and inserted into `memory_entries` with `scope = "transcript/<sessionId>"` and `entry_kind = "transcript"`
- **AND** each chunk SHALL be embedded and stored in `memory_embeddings`

#### Scenario: First sync after migration indexes all existing transcripts

- **GIVEN** the migration has completed and `memory_sources` is empty
- **AND** multiple `transcript.jsonl` files exist from before migration
- **WHEN** the first transcript sync tick runs
- **THEN** every existing `transcript.jsonl` file SHALL be treated as "changed" (no `memory_sources` row to compare against)
- **AND** every file SHALL be parsed, chunked, embedded, and inserted into `memory_entries`
- **AND** `memory_sources` SHALL be populated with a row for each file
- **AND** subsequent sync ticks SHALL skip unchanged files

#### Scenario: Unchanged transcript skipped on sync

- **WHEN** a transcript file's mtime and size match `memory_sources`
- **THEN** the file SHALL NOT be re-parsed or re-indexed

#### Scenario: Deleted session removes transcript entries

- **WHEN** a session directory is removed from `$GOBLIN_HOME/state/sessions/`
- **AND** the next sync tick runs
- **THEN** all `memory_entries` with `scope = "transcript/<sessionId>"` SHALL be deleted
- **AND** corresponding `memory_embeddings` rows SHALL be deleted
- **AND** the corresponding `memory_sources` row for that transcript file SHALL be deleted

#### Scenario: Search returns transcript results

- **WHEN** `memory_search({query: "backup config", corpus: "all"})` matches a past conversation snippet
- **THEN** the result SHALL include `source: "transcript"`, the session ID, and the snippet text
- **AND** transcript results SHALL be ranked alongside memory entries by the same hybrid scoring

#### Scenario: Corpus restriction to memory only

- **WHEN** `memory_search({query: "backups", corpus: "memory"})` is called
- **THEN** transcript entries SHALL NOT appear in results
- **AND** only `memory_entries` with `entry_kind = "memory"` or `entry_kind = "user"` SHALL be searched

### Requirement: Dreaming consolidates memory on a schedule

The system SHALL run scheduled memory consolidation ("dreaming") via the existing scheduler loop. Dreaming SHALL have three phases, each on an independent configurable schedule:

- **Light sleep** (default: every 4 hours): scan transcript entries within a lookback window (default 24 hours). Extract snippets worth remembering via a model-driven extraction pass (using the configured chat model with a focused prompt). Dedupe against existing memory entries using cosine similarity (threshold configurable via `GOBLIN_MEMORY_DEDUP_SIMILARITY_THRESHOLD`, default 0.85). Write a dream diary entry to `$GOBLIN_HOME/state/memory/dreams/<date>.md`. Promote high-confidence snippets (confidence ≥ `GOBLIN_MEMORY_DREAM_CONFIDENCE_THRESHOLD`, default 0.7) to `memory_entries` with `origin = "dreaming"`.

- **REM sleep** (default: daily at 03:00 local): aggregate concept tags across all transcript entries in the lookback window. Detect recurring themes (tags appearing in 3+ distinct sessions). Promote cross-session patterns into durable memory entries with `origin = "dreaming"` and `category = "theme"`.

- **Deep sleep** (default: daily at 04:00 local): promote short-term recall entries (entries with `category = "short_term"` from light sleep) into durable memory. Run budget compaction. Update the dream diary with a summary of promotions.

Dreaming SHALL use the existing subagent spawning mechanism for model-driven extraction. The subagent SHALL receive a focused prompt with the transcript snippets and return structured candidates as a JSON array. Each candidate SHALL have the following fields:

- `text` (string, required) — the durable memory text, written in third person.
- `category` (string, required) — one of `fact`, `short_term`, `theme`, `commitment`, `standing_order`, `skip`.
- `confidence` (number, required) — a value in the range `[0, 1]`.
- `target` (string, optional) — one of `memory`, `user`, `agent`; defaults to `memory`.
- `rationale` (string, optional) — a one-sentence explanation.

Candidates with `category = "skip"` or `confidence` below `GOBLIN_MEMORY_DREAM_CONFIDENCE_THRESHOLD` (default 0.7) SHALL be recorded in `quarantine.jsonl` and SHALL NOT be persisted to `memory_entries`. Malformed subagent output (non-JSON, missing required fields, or invalid enum values) SHALL be appended to `quarantine.jsonl` with reason `malformed` and SHALL NOT crash the dreaming pass.

Dreaming schedule intervals SHALL be expressed as a non-negative integer number of minutes or the literal `off` (case-insensitive). `0` SHALL be equivalent to `off`. The default light sleep interval SHALL be 240 minutes. The default REM and deep sleep intervals SHALL be 1440 minutes. The scheduler SHALL align the first daily phase run to the configured local time (03:00 for REM, 04:00 for deep) by computing the next occurrence after startup; subsequent runs SHALL be spaced by the interval.

Dreaming SHALL NOT block the main event loop — it SHALL run in the scheduler's turn queue.

The dream diary at `$GOBLIN_HOME/state/memory/dreams/<date>.md` SHALL be human-readable markdown for inspection. Narrative-style diary entries (first-person voice) SHALL be off by default and enabled via `GOBLIN_MEMORY_DREAM_NARRATIVE=true`.

#### Scenario: Light sleep extracts and promotes a snippet

- **GIVEN** a transcript contains a conversation where the user explains a homelab convention
- **WHEN** light sleep runs within the lookback window
- **THEN** a subagent SHALL extract the convention as a candidate
- **AND** the candidate SHALL be deduped against existing memory via cosine similarity
- **AND** if novel, the candidate SHALL be inserted into `memory_entries` with `origin = "dreaming"`, `category = "short_term"`, and `promoted_at` set to current time

#### Scenario: REM sleep detects a recurring theme

- **GIVEN** the user discussed "backup failures" across 4 separate sessions in the lookback window
- **WHEN** REM sleep runs
- **THEN** the concept tag "backup" SHALL be detected as recurring (3+ sessions)
- **AND** a theme entry SHALL be promoted to `memory_entries` with `origin = "dreaming"`, `category = "theme"`

#### Scenario: REM sleep counts distinct sessions, not chunks

- **GIVEN** the transcript of session `s1` contains 5 chunks mentioning "backup" and the transcript of session `s2` contains 2 chunks mentioning "backup"
- **WHEN** REM sleep runs
- **THEN** the tag "backup" SHALL be counted as appearing in 2 distinct sessions
- **AND** SHALL NOT be counted as appearing in 7 distinct sessions

#### Scenario: Deep sleep promotes and compacts

- **GIVEN** light sleep created 5 `short_term` entries over the past day
- **WHEN** deep sleep runs
- **THEN** the 5 entries SHALL be promoted to durable status (category changed from `short_term` to `fact`)
- **AND** each promoted entry's `promoted_at` SHALL be set to the current time
- **AND** each promoted entry's `updated_at` SHALL be refreshed
- **AND** budget compaction SHALL run to ensure the total memory size is within budget
- **AND** the dream diary SHALL be updated with a summary of promotions

#### Scenario: Dreaming does not block user turns

- **WHEN** a dreaming phase is running and the user sends a message
- **THEN** the user's turn SHALL be processed without waiting for dreaming to complete
- **AND** dreaming SHALL continue in the background

#### Scenario: Dreaming dedupes against existing memory

- **GIVEN** `memory_entries` already contains "user prefers concise summaries" with high confidence
- **WHEN** light sleep extracts a similar snippet from a transcript of session `s2`
- **THEN** the cosine similarity between the snippet embedding and the existing entry SHALL exceed `GOBLIN_MEMORY_DEDUP_SIMILARITY_THRESHOLD` (default 0.85)
- **AND** the snippet SHALL NOT be inserted as a new entry
- **AND** the existing entry's `updated_at` SHALL be refreshed
- **AND** the existing entry's `source_session` SHALL remain unchanged
- **AND** the existing entry's `updated_source_session` SHALL be set to `s2`

#### Scenario: Standing order candidate is extracted

- **WHEN** a transcript entry contains an explicit durable instruction such as `standing order: remind me to check backups weekly`
- **THEN** the model-driven extractor SHALL produce a `standing_order` memory candidate
- **AND** the candidate SHALL include a confidence score

#### Scenario: Malformed or low-confidence subagent output is quarantined

- **GIVEN** a light sleep subagent returns `[{"text": "..."}]` missing `category` and `confidence`
- **WHEN** the dreaming pipeline processes the output
- **THEN** the malformed output SHALL be appended to `quarantine.jsonl` with reason `malformed`
- **AND** no entry SHALL be inserted into `memory_entries`
- **AND** the dreaming pass SHALL continue with the next transcript range

### Requirement: Budget management with recall-aware auto-compaction

The system SHALL enforce a configurable character budget on the total memory store (default 50,000 chars across all `memory_entries` with `entry_kind = "memory"` or `entry_kind = "user"`). The budget counts only the `text` column — descriptions in `memory_scopes` SHALL NOT be counted toward the budget. The budget SHALL NOT be a per-file cap — it is a global budget across all scopes.

When a write (manual or dreaming-promoted) would push the total over the budget, the system SHALL compact by dropping entries with `origin = "dreaming"` first. Entries with `origin = "user"` (written via `memory_write`) SHALL be preserved unconditionally. If dropping all dreaming entries is insufficient, the write SHALL fail with an overflow error reporting the current size, budget, and overflow amount.

Compaction SHALL use a recall-aware eviction order (see decision `0027-dreaming-model-driven-promotion`):

1. **Never-recalled dreaming entries first:** entries with `recall_count = 0`, ordered by `promoted_at` ascending (oldest promoted first). These are entries that were promoted by dreaming but never surfaced by any `memory_search` — the lowest-quality promotions.
2. **Recalled dreaming entries by least-recent recall:** entries with `recall_count > 0`, ordered by `last_recalled_at` ascending (least-recently-recalled first). When `last_recalled_at` ties, break by `promoted_at` ascending.

This ensures that junk promotions (model-curated but never useful) are evicted before useful entries. Over time, the memory store converges toward entries that are both model-interesting and search-useful.

The budget SHALL be configurable via `GOBLIN_MEMORY_BUDGET_CHARS` (default 50000).

#### Scenario: Dreaming promotion fits within budget

- **WHEN** deep sleep promotes 5 entries totaling 2000 chars and the current total is 45,000 chars with a 50,000 budget
- **THEN** all 5 entries SHALL be promoted
- **AND** no compaction SHALL occur

#### Scenario: Dreaming promotion triggers compaction

- **WHEN** deep sleep promotes 3 entries totaling 8000 chars and the current total is 46,000 chars with a 50,000 budget
- **THEN** compaction SHALL drop the oldest dreaming entries until the total fits
- **AND** user-authored entries SHALL NOT be dropped

#### Scenario: User write exceeds budget after compaction

- **WHEN** `memory_write({action: "add", target: "memory", content: "..."})` would push the total over budget
- **AND** all dreaming entries have been dropped and the total still exceeds budget
- **THEN** the write SHALL fail with an overflow error
- **AND** no entries SHALL be modified

#### Scenario: Replace or rewrite growth exceeds budget after compaction

- **GIVEN** an existing user entry contains 1000 characters and the memory store is at 49,500 of 50,000 characters with no dreaming entries remaining
- **WHEN** `memory_write({action: "replace", target: "memory", old_text: "...", content: "<2000 chars>"})` or `memory_write({action: "rewrite", target: "memory", content: "<2000 chars>"})` would push the total over budget
- **THEN** the write SHALL fail with an overflow error
- **AND** the original entry SHALL remain unchanged

#### Scenario: User entries preserved during compaction

- **GIVEN** memory contains 10 user-authored entries and 20 dreaming entries
- **WHEN** compaction runs to make room for a new promotion
- **THEN** only dreaming entries SHALL be eligible for dropping
- **AND** all 10 user-authored entries SHALL remain

#### Scenario: Never-recalled dreaming entries evicted before recalled ones

- **GIVEN** memory contains two dreaming entries: entry A (promoted 10 days ago, `recall_count = 5`, `last_recalled_at` = 1 day ago) and entry B (promoted 2 days ago, `recall_count = 0`)
- **WHEN** compaction must drop one entry to make room
- **THEN** entry B (never recalled) SHALL be dropped first despite being more recently promoted
- **AND** entry A (frequently recalled) SHALL be preserved

#### Scenario: Recalled dreaming entries evicted by least-recent recall

- **GIVEN** memory contains two dreaming entries with `recall_count > 0`: entry A (last recalled 30 days ago) and entry B (last recalled 1 day ago)
- **WHEN** compaction must drop one entry and both have non-zero recall_count
- **THEN** entry A (least-recently recalled) SHALL be dropped first
- **AND** entry B (recently recalled) SHALL be preserved

### Requirement: Memory CLI

The system SHALL expose a `memory` CLI via `bun run src/memory/cli.ts <command> [args]` for inspecting the SQLite-backed memory store. The CLI SHALL support three commands:

- `memory export` — regenerate the markdown export files from the current SQLite store. It SHALL write `user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, and `agents/<name>/memory.md` using atomic writes (tmp + rename). It SHALL NOT export entries with `entry_kind = "transcript"` or scopes prefixed with `archive/`.
- `memory status` — report database size, total entry count, embedding provider status (model, degraded flag, last error if any), last transcript sync time, and global budget usage (current chars / budget).
- `memory search <query>` — run hybrid search with the same scoring as the `memory_search` tool and print ranked results to stdout.

#### Scenario: Export command writes markdown

- **WHEN** `bun run src/memory/cli.ts export` is executed
- **THEN** markdown files SHALL be written from the SQLite store
- **AND** the directory structure SHALL match the mapping table
- **AND** atomic write (tmp + rename) SHALL be used

#### Scenario: Status command reports counts

- **WHEN** `bun run src/memory/cli.ts status` is executed
- **THEN** the output SHALL include entry count, database size, and embedding provider status

## MODIFIED Requirements

### Requirement: Memory store filesystem layout

The system SHALL maintain a SQLite database at `$GOBLIN_HOME/state/memory/memory.sqlite` as the canonical memory store. The existing markdown directory structure (`user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, `agents/<name>/memory.md`, `archive/topics/`) SHALL be preserved as a read-only export surface.

All `memory.md` and `user.md` files in the directory tree SHALL be regenerated by the `memory export` CLI command from the SQLite store. Direct edits to markdown files SHALL NOT be reflected in the memory store — the SQLite database is canonical.

The `archive/topics/` directory SHALL continue to hold orphaned topic scopes moved during failed Telegram resolves. Archived scopes SHALL be marked in `memory_entries` with a `scope` prefixed by `archive/` and SHALL be excluded from search and index results.

#### Scenario: First write creates SQLite database

- **WHEN** `memory_write` is called with `target = "user"` and `memory.sqlite` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/memory.sqlite` SHALL be created with all tables
- **AND** the entry SHALL be inserted into `memory_entries` with `scope = "user"`, `entry_kind = "user"`

#### Scenario: First write to a new topic scope

- **WHEN** `memory_write` is called with `target = "memory"` from a session in topic `42` and no entries exist for that scope
- **THEN** an entry SHALL be inserted into `memory_entries` with `scope = "topics/<chatId>/42"`, `entry_kind = "memory"`

#### Scenario: Markdown export reflects SQLite state

- **WHEN** `memory export` is run
- **THEN** markdown files SHALL be written from SQLite entries
- **AND** the directory structure SHALL match the existing layout

#### Scenario: Archived scopes excluded from search

- **WHEN** a scope is moved to `archive/topics/<chatId>/<topicId>/` after a failed Telegram resolve
- **THEN** entries with `scope` prefixed by `archive/` SHALL be excluded from `memory_search` results
- **AND** the entries SHALL remain in the SQLite database for recovery

### Requirement: Enforce character caps with overflow errors

The system SHALL enforce a global character budget (default 50,000 chars) across all `memory_entries` with `entry_kind = "memory"` or `entry_kind = "user"`. The budget is configurable via `GOBLIN_MEMORY_BUDGET_CHARS`. Per-file caps (4000 for `memory.md`, 2000 for `user.md`) SHALL be removed — the global budget replaces them. The budget counts only `memory_entries.text` — `memory_scopes.description` SHALL NOT be counted.

When an `add`, `replace`, or `rewrite` operation would push the total over the budget, the system SHALL first attempt compaction (dropping dreaming-promoted entries in recall-aware order: `recall_count = 0` first by `promoted_at` ascending, then `last_recalled_at` ascending, then `promoted_at` ascending). If compaction is insufficient, the operation SHALL fail with an error message reporting the current total, the budget, and the overflow amount. The database MUST NOT be modified on overflow.

#### Scenario: Add within budget succeeds

- **WHEN** the resulting total would be ≤ 50,000 characters
- **THEN** the write SHALL succeed

#### Scenario: Add exceeds budget after compaction

- **WHEN** an `add` would push the total over 50,000 characters
- **AND** compaction drops all dreaming entries but the total still exceeds budget
- **THEN** the write SHALL fail with current=<total>, budget=50000, overflow=<amount>
- **AND** no entries SHALL be modified

### Requirement: memory tool exposes add, replace, remove

The system SHALL expose two memory tools:

1. `memory_search` — hybrid search over memory entries and transcript chunks. Parameters: `query` (string, required for search; optional for index/list), `limit` (integer, default 10, clamped to [1, 50]), `scope` (optional: `"active"`, `"general"`, `{topic: {chatId, topicId}}`, `{agent: {name}}`), `all_chats` (boolean, default false), `corpus` (`"memory"` | `"transcripts"` | `"all"`, default `"all"`). When `query` is omitted and `scope` is provided, returns all entries in that scope (replaces `memory_read`). When `query` is omitted and no `scope` is provided, returns the scope index (replaces `memory_read_index`).

2. `memory_write` — accepts `action` (`"add" | "replace" | "remove" | "rewrite" | "set_description"`), `target` (`"memory" | "user" | "agent"`), `content`, `old_text`, `description`. Same semantics as the existing tool, backed by SQLite.

The `memory_read` and `memory_read_index` tools SHALL be removed. Their functionality is subsumed by `memory_search` with appropriate parameters.

**Ranked search result schema** (when `query` is provided): the tool SHALL return a JSON object `{ results: SearchResult[], degraded: boolean, warning?: string }` where `degraded` is `true` when the embedding provider is unavailable and `warning` contains the error message. Each `SearchResult` SHALL have: `entry_id` (string), `scope` (string), `entry_kind` (string: `"memory"` | `"user"` | `"transcript"`), `source` (string: `"memory"` | `"transcript"`), `score` (number: decayed fused score), `vectorScore` (number: cosine similarity, 0 when degraded), `textScore` (number: normalized BM25), `conceptBoost` (number: applied boost), `text` (string: entry body, truncated to 500 chars with `...` suffix if longer), `tags` (string[]: concept tags), `session_id` (string, present only when `source = "transcript"`), `timestamp` (integer, present only when `source = "transcript"`: approximate transcript time).

**Scope entries schema** (when `query` is omitted and `scope` is provided): the tool SHALL return `{ entries: ScopeEntry[] }` where each `ScopeEntry` has: `entry_id`, `scope`, `entry_kind`, `text` (full, untruncated), `description` (string nullable), `created_at` (integer), `updated_at` (integer), `origin` (string), `tags` (string[]). Entries SHALL be ordered by `created_at` ascending.

**Scope index schema** (when `query` and `scope` are both omitted): the tool SHALL return `{ general: ScopeIndexEntry[], topics: ScopeIndexEntry[], agents: ScopeIndexEntry[] }` where each `ScopeIndexEntry` has: `scope` (string), `description` (string nullable), `entry_count` (integer), `total_chars` (integer). Archived scopes SHALL be excluded.

All mutation actions that write body text (`add`, `replace`, `rewrite`) MUST pass the shared memory safety filter before SQLite persistence. `set_description` SHALL NOT invoke the safety filter — it SHALL validate only that the description is a single line of at most 200 characters (excluding the trailing newline). Failed safety checks or a description exceeding the length cap SHALL return an error and MUST NOT modify the database.

The tool MUST NOT accept a `scope` argument on writes. The active scope is derived from the calling session's `(chatId, topicId)` and named-agent identity.

#### Scenario: Search with query returns ranked results

- **WHEN** `memory_search({query: "backups", limit: 5})` is called
- **THEN** the tool SHALL return up to 5 ranked hybrid search results
- **AND** each result SHALL include scope, entry_kind, source (`memory` or `transcript`), score, and entry text

#### Scenario: Search without query and with scope returns entries

- **WHEN** `memory_search({scope: {topic: {chatId: -100123, topicId: 7}}})` is called without a query
- **THEN** the tool SHALL return all entries in scope `topics/-100123/7`
- **AND** results SHALL not be ranked (insertion order by `created_at`)

#### Scenario: Search without query and without scope returns index

- **WHEN** `memory_search({})` is called without a query or scope
- **THEN** the tool SHALL return the scope index with `general`, `topics`, and `agents` fields
- **AND** archived scopes SHALL be excluded

#### Scenario: Index omits agents for subagents

- **WHEN** `memory_search({})` is called by a named subagent or an anonymous subagent
- **THEN** the `agents` field SHALL be absent or empty
- **AND** the `general` and `topics` fields SHALL be present
- **AND** only the calling subagent's own persona scope SHALL be searchable (named subagent), or no persona scope (anonymous subagent)

#### Scenario: Add operation in active scope

- **WHEN** the tool is called with `{action: "add", target: "memory", content: "..."}` and content passes the safety filter
- **THEN** the content SHALL be inserted into `memory_entries` with the active scope
- **AND** the entry SHALL be embedded

#### Scenario: set_description rejects over-length or multi-line description

- **WHEN** `memory_write({action: "set_description", target: "memory", description: "<251 characters or string containing a newline>"})` is called
- **THEN** the tool SHALL return a validation error
- **AND** the description SHALL NOT be persisted to `memory_scopes`

#### Scenario: set_description does not count toward the character budget

- **WHEN** `memory_write({action: "set_description", target: "memory", description: "homelab + dotfiles"})` is called and the memory store is at 49,999 of 50,000 characters
- **THEN** the description SHALL be persisted as a `memory_scopes` row for the active scope
- **AND** the write SHALL NOT fail with a budget overflow error
- **AND** the `memory_scopes.description` column SHALL NOT be counted toward the global character budget (only `memory_entries.text` is counted)

#### Scenario: Corpus restriction to transcripts

- **WHEN** `memory_search({query: "deployment", corpus: "transcripts"})` is called
- **THEN** only transcript entries SHALL be searched
- **AND** memory entries SHALL NOT appear in results

### Requirement: Memory search ranks entries lexically

The system SHALL provide hybrid search over memory entries and transcript chunks, combining vector cosine similarity, BM25 lexical ranking, and concept tag boosts. The existing purely-lexical search SHALL be replaced by hybrid search.

Text normalization for concept-tag extraction SHALL lowercase both query and entry text, strip leading/trailing whitespace, and split on whitespace and punctuation into tokens. Unicode letters and digits SHALL be preserved as token characters.

Search scoring SHALL use weighted fusion: `score = vectorWeight * vectorScore + textWeight * textScore + conceptBoost`, where `vectorScore` is cosine similarity and `textScore` is the normalized BM25 rank (`1/(1+rank)` for non-negative ranks, `relevance/(1+relevance)` for negative ranks). Default weights SHALL be `vectorWeight = 0.7`, `textWeight = 0.3`. Entries matching concept tags derived from the query SHALL receive an additive boost: `conceptBoost = min(0.1 * matchingTagCount, 0.3)`. After fusion and concept boost, temporal decay SHALL be applied: `decayedScore = score * exp(-ln(2) * ageInDays / halfLifeDays)` (half-life default 30 days). After temporal decay, MMR re-ranking SHALL be applied when the number of results exceeds the requested limit by a factor of 2, using `mmrScore = lambda * normalizedRelevance - (1-lambda) * maxJaccardSimilarity` with lambda default 0.7 and min-max score normalization. The relative signal weights and fusion formula SHALL be pinned by unit tests.

The `limit` parameter SHALL default to 10 when absent and SHALL be clamped to the range `[1, 50]`. Values `<= 0` SHALL be treated as the default (10); values `> 50` SHALL be clamped to 50.

When the embedding provider is in degraded state, search SHALL fall back to BM25-only ranking with a warning in the response.

#### Scenario: Semantic match ranks above lexical non-match

- **WHEN** `memory_search({query: "glacier archive failure"})` is called and an entry contains "the backup script broke" with high cosine similarity
- **THEN** that entry SHALL appear in results despite zero lexical token overlap

#### Scenario: FTS-only fallback returns lexical results

- **GIVEN** the embedding provider is in degraded state
- **WHEN** `memory_search({query: "backups"})` is called
- **THEN** results SHALL be ranked by BM25 only
- **AND** a warning indicator SHALL be included in the response

#### Scenario: No matches

- **WHEN** no entry has semantic or lexical overlap with the query
- **THEN** `memory_search` SHALL return an empty results array
- **AND** SHALL NOT throw

#### Scenario: Empty or whitespace query rejected

- **WHEN** `memory_search({query: "   "})` or `memory_search({query: ""})` is called
- **THEN** the tool SHALL return a validation error
- **AND** SHALL NOT search the database
- **AND** `memory_search({})` (query omitted) SHALL remain valid and return the scope index

#### Scenario: Invalid limit clamped

- **WHEN** `memory_search({query: "backups", limit: 0})` is called
- **THEN** the tool SHALL behave as if `limit = 10` was supplied

### Requirement: Snapshot format for prompt injection

The system SHALL inject a bounded memory summary into the system prompt at session creation time. The summary SHALL be frozen for the duration of the session — mid-session memory writes SHALL NOT refresh the system prompt.

The frozen summary SHALL include:
1. The active scope's description (or `(no description)`).
2. A bounded summary of `user.md` entries (max 500 chars).
3. A bounded summary of the active scope's `memory.md` entries (max 500 chars).

The summary SHALL be prefixed with `[goblin memory summary (frozen at session start)]` and SHALL NOT exceed 1200 chars total. The summary SHALL be omitted entirely when all memory sources are empty.

The summary is assembled from the following parts in priority order: header, active scope description, `user.md` summary (max 500 chars), active scope `memory.md` summary (max 500 chars), cross-scope index (max 10 entries). The cross-scope index SHALL be ordered by most recently updated scope first (descending `MAX(updated_at)` across entries in that scope), then by scope name ascending for ties. If the assembled summary exceeds 1200 characters, the cross-scope index SHALL be trimmed first by dropping entries from the end (i.e. the least-recently-updated scopes); if still over budget, the active scope `memory.md` summary SHALL be truncated at a word boundary; if still over budget, the `user.md` summary SHALL be truncated at a word boundary. The header and active scope description SHALL NOT be truncated.

The per-turn `[goblin memory snapshot]` aside SHALL be removed. The `## relevant memory` section (computed via hybrid search on the current prompt text) SHALL remain as the per-turn memory signal.

#### Scenario: Session start includes frozen summary

- **WHEN** a new session is created and memory is non-empty
- **THEN** the system prompt SHALL include the frozen summary block
- **AND** the block SHALL NOT exceed 1200 chars

#### Scenario: Mid-session write does not refresh system prompt

- **WHEN** `memory_write` adds an entry during a session
- **THEN** the system prompt SHALL NOT be updated
- **AND** the new entry SHALL be discoverable via `memory_search`

#### Scenario: Empty memory produces no summary

- **WHEN** a new session is created and all memory sources are empty
- **THEN** the system prompt SHALL NOT include a frozen summary block

#### Scenario: Over-budget frozen summary trims cross-scope index and summaries

- **GIVEN** the active scope description, `user.md` summary, and active scope `memory.md` summary together exceed 1200 characters
- **WHEN** a new session is created
- **THEN** the frozen summary SHALL NOT exceed 1200 characters
- **AND** the cross-scope index SHALL be trimmed or omitted first
- **AND** if still over budget, the active scope `memory.md` summary SHALL be truncated at a word boundary
- **AND** the header and active scope description SHALL remain intact

### Requirement: Per-turn snapshot includes active scope and cross-scope index

The frozen system prompt summary SHALL include the active scope description and a bounded cross-scope index. The cross-scope index SHALL list same-chat topic scopes with their descriptions, limited to 10 entries. The `## other scopes` section from the per-turn snapshot is moved into the frozen summary.

The `## relevant memory` section SHALL be computed per-turn via hybrid search on the current prompt text with `corpus = "memory"`, returning up to 3 ranked results from memory entries (not transcripts) by default and clamped to a maximum of 5. Results that verbatim-match the active scope's frozen summary SHALL be deduplicated.

#### Scenario: Frozen summary includes cross-scope index

- **WHEN** a session is created in topic `42` and topics `7` and `11` also have non-empty memory
- **THEN** the frozen summary SHALL include a cross-scope index listing topics `7` and `11` with descriptions
- **AND** the index SHALL be limited to 10 entries

#### Scenario: Relevant memory computed per-turn

- **WHEN** a turn is dispatched with prompt text mentioning "backups"
- **THEN** a `## relevant memory` section SHALL be computed via hybrid search
- **AND** the section SHALL include up to 3 ranked results
- **AND** results already in the frozen summary SHALL be deduplicated

### Requirement: Snapshot may include relevant memory

The `## relevant memory` section SHALL be computed via hybrid search (vector + BM25 + concept tags) on the current prompt text with `corpus = "memory"`, replacing the previous lexical-only search. The section SHALL return up to 3 results from memory entries (not transcripts) by default and SHALL be clamped to a maximum of 5.

The section SHALL be omitted when no prompt text is supplied, no relevant entries are found, or all memory sources are empty. The section SHALL skip any entry whose display text already appears in the frozen system prompt summary.

The `## relevant memory` section SHALL be injected as a per-turn aside via `sendCustomMessage(..., { deliverAs: "nextTurn" })` before each `prompt()` call. The frozen summary SHALL NOT be re-injected per-turn — it lives in the system prompt.

#### Scenario: Prompt-specific relevant memory included

- **WHEN** a new prompt mentions a phrase that semantically matches an entry in another scope
- **THEN** the per-turn aside SHALL include a `## relevant memory` section with the matching entry and scope id
- **AND** the frozen system prompt summary SHALL remain unchanged

#### Scenario: No query omits relevant memory

- **WHEN** the turn is dispatched without prompt text (e.g. heartbeat)
- **THEN** the per-turn aside SHALL omit `## relevant memory`

#### Scenario: Relevant memory deduplicates frozen summary

- **GIVEN** the frozen summary contains an entry about "user prefers concise summaries"
- **WHEN** `## relevant memory` is computed for a prompt about summaries
- **THEN** that entry SHALL be omitted from `## relevant memory`
- **AND** entries not in the frozen summary SHALL appear normally

### Requirement: Memory search defaults to current chat scopes

Memory search SHALL default to searching `user` entries, the active scope, the current chat's topic scopes, and eligible named-agent persona scopes. Transcript entries from the current chat SHALL be searched by default when `corpus` is `"all"` (the default), filtered by the `chat_id` column on `memory_entries`. When `corpus` is `"memory"`, transcript entries SHALL be excluded. When `corpus` is `"transcripts"`, only transcript entries from the current chat SHALL be searched unless `all_chats` is `true`.

Topic scopes from other chats MUST NOT be searched unless `all_chats = true` is supplied. The search input SHALL NOT accept free-form filesystem paths. When the caller has no `chat_id` (e.g. the dreaming internal session), `corpus = "all"` SHALL include transcript entries from all chats (equivalent to `all_chats = true`); `corpus = "transcripts"` SHALL also include all chats. This avoids excluding all transcripts when the caller has no chat binding.

#### Scenario: Same-chat topics searched by default

- **WHEN** `memory_search({query: "deployment"})` is called from chat `-100123` topic `42` by the main goblin agent
- **THEN** the search SHALL consider `user` entries, `topics/-100123/42` entries, other topic scopes under `topics/-100123/`, general memory, every `agents/<name>` persona scope, and transcript entries from sessions in chat `-100123`
- **AND** SHALL NOT consider topic scopes under a different chat id
- **AND** SHALL NOT consider transcript entries from sessions in a different chat id

#### Scenario: Corpus restriction to memory

- **WHEN** `memory_search({query: "deployment", corpus: "memory"})` is called
- **THEN** transcript entries SHALL NOT be searched
- **AND** only memory and user entries SHALL be searched

#### Scenario: Cross-chat search opt-in

- **WHEN** `memory_search({query: "deployment", all_chats: true})` is called
- **THEN** the search SHALL include topic scopes from any chat
- **AND** transcript entries from sessions in any chat SHALL be searched

### Requirement: Reflection categorizes explicit commitments and standing orders

The dreaming pipeline SHALL support `commitment` and `standing_order` entry categories for explicit durable statements. Extraction SHALL use a model-driven extraction pass (via subagent) rather than regex patterns. The model SHALL receive transcript snippets and return structured candidates with category, confidence, and target scope.

The model-driven extractor SHALL NOT infer commitments from vague intent or ordinary task requests. The extraction prompt SHALL include explicit instructions to distinguish durable commitments from transient task requests.

#### Scenario: Explicit commitment candidate

- **WHEN** a transcript entry contains an explicit durable commitment such as `I commit to reviewing invoices every Friday`
- **THEN** the model-driven extractor SHALL produce a `commitment` memory candidate
- **AND** the candidate SHALL include a confidence score

#### Scenario: Vague request is not inferred

- **WHEN** a transcript entry says `I should probably check backups sometime`
- **THEN** the model-driven extractor SHALL NOT produce a commitment or standing-order candidate

### Requirement: Reflection filters procedural noise before persistence

The dreaming pipeline SHALL reject procedural commands, tiny fragments, small talk, and unsupported guesses before trusted memory persistence. The model-driven extraction prompt SHALL include explicit instructions to skip transient task requests and small talk. Rejected low-confidence candidates SHALL go to quarantine; obvious noise MAY be skipped without quarantine.

#### Scenario: Procedural command is skipped

- **WHEN** transcript text contains a one-off procedural command such as "run the tests now"
- **THEN** the model-driven extractor SHALL NOT produce a candidate
- **AND** no entry SHALL be persisted

### Requirement: Memory entries carry provenance metadata

Memory entries SHALL include `created_at`, `updated_at`, `source_session`, `updated_source_session`, `source_role`, `category`, `confidence`, and `origin` (`user` or `dreaming`) as columns in `memory_entries`. The `origin` field distinguishes manually-written entries from dreaming-promoted entries and drives budget compaction eligibility. When a dreaming candidate updates an existing entry, `source_session` SHALL be preserved, `updated_at` and `updated_source_session` SHALL be refreshed, and `created_at` SHALL remain unchanged.

#### Scenario: User write records origin

- **WHEN** `memory_write({action: "add", target: "memory", content: "..."})` is called
- **THEN** the entry SHALL be inserted with `origin = "user"`

#### Scenario: Dreaming promotion records origin

- **WHEN** light sleep promotes a snippet from a transcript of session `s1`
- **THEN** the entry SHALL be inserted with `origin = "dreaming"`, `source_session` set to `s1`, `updated_source_session` set to `s1`, and `promoted_at` set to current time

### Requirement: Active-scope-to-memory-scope conversion has one home

The system SHALL provide the `ActiveScope → MemoryScope` conversion in exactly one module: `src/memory/scope.ts`. The conversion SHALL be exported from `scope.ts` and imported by every consumer. No other module SHALL define a private `activeMemoryScopeFor` or `activeMemoryScope` function. The conversion SHALL produce the `(scope, entry_kind)` pair used by `memory_entries`.

#### Scenario: Single source for the conversion

- **WHEN** any module needs to convert an `ActiveScope` to a SQLite `scope`/`entry_kind` pair
- **THEN** it SHALL import the conversion from `src/memory/scope.ts`
- **AND** SHALL NOT define its own copy of the function

### Requirement: Reflection candidates consolidate with existing entries

Automatic memory writes SHALL prefer consolidation over append-only accumulation. When a new dreaming candidate is a near-duplicate of, or update to, an existing entry in the resolved target, the pipeline SHALL replace or rewrite the existing entry while preserving the original `created_at` and original `source_session`, updating `updated_at`, and recording the newest observed source session in `updated_source_session`. It MUST NOT append redundant entries that express the same durable fact.

#### Scenario: Candidate updates an existing preference

- **GIVEN** `memory_entries` contains a user preference entry from session `s1`
- **WHEN** dreaming extracts a correction from session `s2`
- **THEN** the pipeline SHALL update the existing row rather than inserting a duplicate
- **AND** `created_at` SHALL remain unchanged
- **AND** `source_session` SHALL remain `s1`
- **AND** `updated_at` and `updated_source_session` SHALL be set to the current time and `s2`

### Requirement: Memory scopes by chat surface and named agent

The system SHALL key each memory scope by one of:
- `general` — DMs and supergroup-no-topic chats. Resolves in the SQLite store to `memory_entries` rows with `scope = "general"` and `entry_kind = "memory"`. Exported to `$GOBLIN_HOME/state/memory/general/memory.md` by `memory export`.
- A topic scope identified by `(chatId, topicId)`. Resolves to rows with `scope = "topics/<chatId>/<topicId>"` and `entry_kind = "memory"`. Exported to `topics/<chatId>/<topicId>/memory.md`.
- A named-agent persona scope identified by `<name>` where `<name>` is a sanitized named-agent identifier. Resolves to rows with `scope = "agents/<name>"` and `entry_kind = "memory"`. Exported to `agents/<name>/memory.md`.

Topic-scope keying SHALL use the numeric Telegram topic ID, not the topic's display name. Renaming a forum topic in Telegram MUST NOT change the resolved scope. The `general` scope is shared across every DM and every supergroup-no-topic chat.

`user.md` is global and lives at `scope = "user"`, `entry_kind = "user"`. There is no per-scope `user` scope. Exported to `$GOBLIN_HOME/state/memory/user.md`.

#### Scenario: First write in a topic creates its scope entries

- **WHEN** `memory_write` is called with `target = "memory"` from a session bound to `(chatId=-100123, topicId=42)` and no entries exist for that scope
- **THEN** a new row SHALL be inserted into `memory_entries` with `scope = "topics/-100123/42"`, `entry_kind = "memory"`
- **AND** no directory creation is required (SQLite is the canonical store)

#### Scenario: First write in a DM resolves to general scope

- **WHEN** `memory_write` is called with `target = "memory"` from a DM session and no `general` scope entries exist
- **THEN** a new row SHALL be inserted into `memory_entries` with `scope = "general"`, `entry_kind = "memory"`

#### Scenario: First write to a named agent's persona resolves to that agent's scope

- **WHEN** `memory_write` is called with `target = "agent"` from a named subagent `researcher` and no `agents/researcher` scope entries exist
- **THEN** a new row SHALL be inserted into `memory_entries` with `scope = "agents/researcher"`, `entry_kind = "memory"`

#### Scenario: Topic rename does not move the scope

- **WHEN** the user renames the forum topic with id `42` in Telegram from `Health` to `Wellness`
- **THEN** the scope `topics/<chatId>/42` SHALL remain unchanged
- **AND** subsequent reads and writes SHALL continue to use the same scope

### Requirement: Scope description provides progressive disclosure

Each scope MAY carry a one-line description stored in the `memory_scopes` table (≤ 200 characters, single line). The description is per-scope: it is stored as a single row in `memory_scopes` and surfaced in the cross-scope index of the frozen summary, formatted as `- <scope-id> — <description>`. When a scope has no description (no `memory_scopes` row or `description = NULL`), the section SHALL fall back to the Telegram topic name for topic scopes (best-effort lookup) or the literal string `(no description)` otherwise.

The `memory_write` tool SHALL expose a `set_description` action that upserts a single row in `memory_scopes` for the active scope without modifying any `memory_entries` rows. This SHALL succeed even when the scope has zero entries — the `memory_scopes` row is independent of `memory_entries` (see decision `0028-memory-scopes-table`). The `memory export` CLI SHALL write the description as a YAML-style frontmatter header in the exported `memory.md` file for inspectability.

#### Scenario: Set description on a topic scope

- **WHEN** `memory_write` is called with `{action: "set_description", target: "memory", description: "homelab + dotfiles"}` from a session bound to topic `7`
- **THEN** a row SHALL be upserted in `memory_scopes` with `scope = "topics/<chat>/7"` and `description = "homelab + dotfiles"`
- **AND** no `memory_entries` rows SHALL be modified

#### Scenario: Set description on an empty scope succeeds

- **GIVEN** scope `topics/-100123/42` has zero entries in `memory_entries`
- **WHEN** `memory_write` is called with `{action: "set_description", target: "memory", description: "future project"}` from a session bound to topic `42`
- **THEN** a row SHALL be inserted into `memory_scopes` with `scope = "topics/-100123/42"` and `description = "future project"`
- **AND** the description SHALL persist and be surfaced in the cross-scope index even though the scope has no entries

#### Scenario: Export writes description as frontmatter

- **WHEN** `memory export` is run and a scope has a description
- **THEN** the exported `memory.md` SHALL include a YAML frontmatter header with `description: <value>`
- **AND** entries SHALL follow the frontmatter

#### Scenario: Frozen summary uses descriptions for cross-scope index

- **WHEN** the frozen summary is built and topic `7` has description "homelab + dotfiles"
- **THEN** the cross-scope index SHALL contain a line `- topics/<chat>/7 — homelab + dotfiles`

### Requirement: Atomic writes

All mutations to the canonical SQLite memory store SHALL use atomic SQLite transactions. The database SHALL use WAL journal mode for concurrent read/write safety.

Markdown export files SHALL use atomic write (write to temp file in `$GOBLIN_HOME/state/memory/`, then rename to final path) to guarantee no partial files on crash.

#### Scenario: SQLite write succeeds

- **WHEN** `memory_write` inserts or updates an entry
- **THEN** the mutation SHALL execute within a SQLite transaction
- **AND** the transaction SHALL commit atomically

#### Scenario: Export write interrupted

- **WHEN** the process crashes mid-export
- **THEN** the original markdown file SHALL remain intact (the temp file may be left behind)

### Requirement: Memory writes are restricted to the active scope

The `memory_write` tool SHALL resolve its target's scope from the calling session's `(chatId, topicId)` (or named-agent identity for `target: "agent"`). The tool's input schema MUST NOT accept an arbitrary scope argument on writes. Attempts by the agent to write to any scope other than the active one SHALL be impossible by construction.

The `target` parameter on `memory_write` accepts only:
- `"memory"` — the active topic scope, or `general` for DMs/supergroup-no-topic.
- `"user"` — the global `user` scope.
- `"agent"` — the calling named subagent's persona memory. Rejected with an error when the caller is the main agent or an anonymous subagent.

#### Scenario: Write from a topic targets that topic's scope

- **WHEN** `memory_write({action: "add", target: "memory", content: "..."})` is called from a session bound to topic `42`
- **THEN** the entry SHALL be inserted into `memory_entries` with `scope = "topics/<chat>/42"`, `entry_kind = "memory"`
- **AND** no other scope's entries SHALL be modified

#### Scenario: target=agent rejected for main agent

- **WHEN** `memory_write({action: "add", target: "agent", content: "..."})` is called from the main goblin agent
- **THEN** the tool SHALL return an error stating that `target = "agent"` is only valid for named subagents
- **AND** no entry SHALL be inserted

### Requirement: Orphan topic scopes move to archive on failed resolve

When goblin attempts a Telegram operation against a topic and Telegram responds with a not-found error, the system SHALL mark the topic's `memory_entries` rows as archived by prefixing their `scope` with `archive/` (e.g., `topics/<chatId>/<topicId>` → `archive/topics/<chatId>/<topicId>`). After the update, the scope SHALL NOT appear in `memory_search` index results or search results.

The `general` scope and named-agent persona scopes are NOT subject to orphan handling. Detection SHALL NOT poll Telegram; the update is triggered only on the next failed resolve.

#### Scenario: Topic deleted in Telegram, next operation surfaces 404

- **WHEN** the user deletes a forum topic in Telegram
- **AND** goblin next attempts to send or edit a message in that topic
- **AND** Telegram returns a "topic not found" error
- **THEN** all `memory_entries` rows with `scope = "topics/<chatId>/<topicId>"` SHALL have their `scope` updated to `archive/topics/<chatId>/<topicId>`
- **AND** subsequent `memory_search` calls SHALL omit the orphaned scope from index and search results

#### Scenario: General scope is exempt

- **WHEN** any failed resolve occurs
- **THEN** `scope = "general"` entries SHALL NOT be modified or archived

### Requirement: Cross-scope discovery defaults to the current chat

The `memory_search` tool's index response (query omitted, scope omitted) and the frozen summary's cross-scope index SHALL default to listing only scopes within the calling session's `chatId`. Topic scopes whose `chatId` differs from the caller's chat MUST NOT appear by default in either the index or the frozen summary.

`memory_search` SHALL accept an optional boolean parameter `all_chats` (default `false`). When `all_chats: true`, the index response SHALL include topic scopes from every `chatId`, with the chat id rendered alongside the topic id in each entry. The frozen summary's cross-scope index is NOT influenced by this parameter — it is always current-chat-only — to keep the system prompt bounded.

The `general` scope and named-agent persona scopes are not chat-scoped and SHALL appear in every index response. In the frozen summary, `general` appears in the cross-scope index only when it is not the active scope. Named-agent persona scopes appear in the cross-scope index when the caller is the main goblin agent.

#### Scenario: Default index from chat A excludes chat B's topics

- **GIVEN** topics exist at `topics/A/1`, `topics/A/2`, and `topics/B/9`
- **WHEN** `memory_search({})` is called from a session in chat `A`
- **THEN** the returned `topics` array SHALL contain entries for `A/1` and `A/2`
- **AND** the array SHALL NOT contain an entry for `B/9`
- **AND** the response SHALL include a `general` field

#### Scenario: all_chats opt-in surfaces every topic

- **WHEN** `memory_search({all_chats: true})` is called from a session in chat `A`
- **THEN** the returned `topics` array SHALL include scopes from every `chatId`

#### Scenario: Frozen summary cross-scope index is current-chat only

- **WHEN** the frozen summary is built for a session in chat `A`
- **THEN** the cross-scope index SHALL list only `A/*` topics plus `general`
- **AND** SHALL NOT list topic scopes from any other `chatId`

### Requirement: Snapshot marks memory as auxiliary and possibly stale

The frozen memory summary SHALL explicitly state that memory may be stale or incomplete and that the current user message, recent tool results, and explicit instructions override memory. This warning MUST appear near the frozen summary header and MUST NOT be omitted when a non-null summary is produced.

#### Scenario: Non-empty frozen summary includes guardrail text

- **WHEN** the frozen summary is produced for non-empty memory
- **THEN** the summary SHALL begin with `[goblin memory summary (frozen at session start)]`
- **AND** it SHALL include text stating memory may be stale or incomplete
- **AND** it SHALL state current context overrides memory

### Requirement: Quarantine stores rejected memory candidates outside snapshots

The system SHALL maintain `$GOBLIN_HOME/state/memory/quarantine.jsonl` for rejected automatic candidates that are unsafe, low-confidence, or need review. Quarantine records SHALL include timestamp, source session, target scope, category, reason, and a redacted candidate preview. For `malformed` records (non-JSON or missing-field subagent output), the preview SHALL contain a truncated (≤200 char) fragment of the raw subagent output. Quarantine contents MUST NOT appear in the frozen summary, `## relevant memory` aside, or `memory_search` results.

#### Scenario: Unsafe candidate is quarantined

- **WHEN** a dreaming candidate is rejected because it resembles a secret
- **THEN** a redacted record SHALL be appended to `quarantine.jsonl`
- **AND** the candidate SHALL NOT be inserted into `memory_entries`

#### Scenario: Low-confidence candidate is quarantined

- **WHEN** dreaming extracts a candidate with `confidence < GOBLIN_MEMORY_DREAM_CONFIDENCE_THRESHOLD` (default 0.7) and the candidate is not otherwise unsafe
- **THEN** a record SHALL be appended to `quarantine.jsonl` with reason `low_confidence`
- **AND** the candidate SHALL NOT be inserted into `memory_entries`

#### Scenario: Search and snapshots exclude quarantine

- **WHEN** `quarantine.jsonl` contains rejected candidates and all trusted memory entries are empty
- **THEN** the frozen summary SHALL be omitted
- **AND** `memory_search` results SHALL NOT mention quarantine

## REMOVED Requirements

### Requirement: Entry delimiter

### Requirement: Git-backed versioning

### Requirement: Memory reads support cross-scope retrieval

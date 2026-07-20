# memory-engine

## Motivation

The current memory system is a curated scratchpad: two markdown files (`memory.md` capped at 4000 chars, `user.md` at 2000 chars) with `§`-delimited entries, lexical substring search, and regex-based reflection. It works for a few dozen manually-curated facts but breaks down as a real memory system:

- **6000 char hard cap.** Memory cannot grow beyond a sticky note. There is no compaction, no promotion, no way to prioritize fresh over stale.
- **No semantic recall.** `memory_search` is lexical token overlap. It cannot find "the backup script broke" when searching for "glacier archive failure" — the words don't overlap.
- **No transcript indexing.** The agent cannot recall what was said in past conversations, only what was manually curated into `memory.md`. Session transcripts (`transcript.jsonl`) are written but never indexed or searched.
- **Brittle reflection.** The `MemoryReflector` extracts durable facts via regex patterns. It misses nuance, cannot detect themes across sessions, and cannot promote short-term observations into durable memory.
- **Full snapshot per turn.** The entire memory store is injected into every prompt as a per-turn aside. As memory grows, this becomes a fixed token tax with no relevance filtering.

OpenClaw's `memory-core` plugin solves these problems with: SQLite-backed hybrid search (vector + BM25), session transcript indexing, concept vocabulary tagging, dreaming (model-driven memory consolidation), and budget management (auto-compaction of promoted entries). It is MIT-licensed and runs on the same `pi` family of agent runtimes.

This change adapts ideas and algorithms from `memory-core` into `little-goblin`, adapted for a single-user, single-process, Bun-based Telegram agent. The goal is a real memory system that grows, learns, and recalls by meaning — not a bigger scratchpad.

**What is ported (algorithmic reuse):** Hybrid search fusion (`hybrid.ts`), MMR (`mmr.ts`), temporal decay (`temporal-decay.ts`), and concept vocabulary tagging (`concept-vocabulary.ts`) are ported as algorithms — the source is studied, imports are inlined, and the logic is reimplemented in `src/memory/`. These are self-contained mathematical functions with no external dependencies.

**What is adapted (different architecture, same inspiration):** Budget compaction and dreaming are not ports. OpenClaw's `memory-budget.ts` operates on markdown files with `## Promoted From Short-Term Memory (DATE)` sections; little-goblin's budget operates on SQLite rows with `origin = "dreaming"`. OpenClaw's dreaming uses a 2932-line recall store (`short-term-promotion.ts`) that gates promotion on behavioral recall signals (3+ recalls across 2+ queries on multiple days); little-goblin's dreaming uses model-opinion confidence as the promotion signal, with a lightweight per-entry `recall_count`/`last_recalled_at` signal to guide budget compaction. See decision `0027-dreaming-model-driven-promotion`.

Before implementation, the referenced `memory-core` source files must be obtained and vendored under `src/memory/vendor/` with MIT license headers (for the ported algorithms only: hybrid, MMR, temporal decay, concept vocabulary). The adapted components (budget, dreaming) are reimplemented from scratch and do not vendor openclaw source.

## Scope

### Capabilities affected

- **memory** — major rework of storage, search, reflection, and snapshot
- **sessions** — transcript indexing integration (read-only consumer)
- **orchestration** — dreaming schedule integration via the existing scheduler

### What changes

**Storage layer (new):**
- SQLite database at `$GOBLIN_HOME/state/memory/memory.sqlite` replaces markdown files as the canonical store for memory entries.
- Schema: `memory_entries` (id, scope, entry_kind, text, created_at, updated_at, source_session, updated_source_session, source_role, category, confidence, origin, promoted_at, chat_id, recall_count, last_recalled_at), `memory_embeddings` (entry_id, provider, model, hash, embedding, dims, updated_at), `memory_index_fts` (FTS5 contentful virtual table storing its own copy of entry text, manually maintained on every insert/delete), `memory_sources` (path, source, hash, mtime, size, updated_at for source sync tracking), `memory_meta` (key-value store for schema version, migration state, embedding provider identity, reindex flag), `memory_entry_tags` (entry_id, tag for concept vocabulary tags), `memory_scopes` (scope, description, updated_at for per-scope metadata normalization — see decision `0028-memory-scopes-table`). The `description` column lives on `memory_scopes`, not `memory_entries`.
- `entry_kind` values are `memory`, `user`, and `transcript`. The `memory_write` tool `target` (`memory` | `user` | `agent`) resolves to a `(scope, entry_kind)` pair; it is not stored literally. Persona memory is scope `agents/<name>` with `entry_kind = "memory"`; transcript snippets are scope `transcript/<sessionId>` with `entry_kind = "transcript"`.
- Markdown files (`memory.md`, `user.md`) remain as a read-only export surface for inspectability. A `memory export` CLI command writes the current SQLite store to markdown. Git history moves to the SQLite store (entries carry `created_at`/`updated_at` timestamps).
- Existing markdown entries are migrated into SQLite on first startup via a one-shot migration.

**Search layer (new):**
- Hybrid search: cosine similarity on embeddings + BM25 on FTS5, fused with weighted scoring. Algorithm ported from `memory-core/src/memory/hybrid.ts`.
- Concept vocabulary tagging: multi-language stop-word filtering, compound token detection, `Intl.Segmenter` word segmentation, protected technical glossary. Algorithm ported from `memory-core/src/concept-vocabulary.ts`.
- MMR (Maximal Marginal Relevance) re-ranking for diversity in search results. Algorithm ported from `memory-core/src/memory/mmr.ts`.
- Temporal decay: recency-aware scoring that down-weights stale entries. Algorithm ported from `memory-core/src/memory/temporal-decay.ts`.
- Configurable fusion weights via `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT` (defaults 0.7 and 0.3, clamped to [0, 1]).
- FTS-only fallback: if the embedding provider is unavailable (rate limit, network error, key expired), search degrades to BM25-only without crashing. Simplified version of `memory-core`'s provider fallback state machine.
- Recall tracking: `memory_search` increments `recall_count` and updates `last_recalled_at` on returned entries, providing a quality signal for budget compaction (see decision `0027-dreaming-model-driven-promotion`).

**Embedding provider (new):**
- Direct `fetch()` to OpenAI `text-embedding-3-small` (configurable model). No plugin registry, no multi-provider support.
- API key read from `GOBLIN_MEMORY_EMBEDDING_API_KEY` (falls back to `OPENAI_API_KEY` for backward compatibility); optional base URL from `GOBLIN_MEMORY_EMBEDDING_BASE_URL` (falls back to `OPENAI_BASE_URL`). These are independent of the chat provider credentials.
- Embedding cache by text hash in SQLite (`memory_embeddings` table). Re-embeds only when the text changes or the model changes.
- Batch embedding on reindex. Single embedding on write.

**Session transcript indexing (new):**
- Index `transcript.jsonl` files into SQLite for semantic search over conversation history.
- Delta-based sync: track file mtime/size in `memory_sources`, reindex only changed files. Debounced batch processing.
- Transcript entries are chunked (message-level, bounded snippet size) and embedded alongside memory entries.
- Search can recall both curated memory entries and past conversation snippets. Results distinguish `source: memory` from `source: transcript`.

**Dreaming (new, adapted from openclaw's phase structure — see decision `0027-dreaming-model-driven-promotion`):**
- Scheduled memory consolidation via the existing scheduler loop. Three phases, run on configurable minute intervals:
  - **Light sleep:** scan recent transcript entries (lookback window), extract snippets worth remembering via a model-driven extraction pass, dedupe against existing memory, write a dream diary entry. Default interval 240 minutes.
  - **REM sleep:** detect recurring themes across multiple sessions using concept vocabulary tags. Promote cross-session patterns into durable memory. Default interval 1440 minutes, aligned to 03:00 local.
  - **Deep sleep:** promote short-term recall entries into durable memory. Run budget compaction to make room. Default interval 1440 minutes, aligned to 04:00 local.
- Dreaming turns are dispatched to a dedicated internal session with id `__goblin_dreaming__` (created via `SessionManager.ensureInternal`, `chatId: 0` sentinel, no Telegram binding) and processed through the existing per-session scheduler queue via a new `TurnDispatcher.enqueueInternalTurn` method (no beta tools, capture buffer, `onComplete` return path — see decision `0029-dreaming-internal-session-dispatch`). Dreaming phases are managed as scheduler timers, NOT registered in `ScheduleStore`.
- Dream diary stored at `$GOBLIN_HOME/state/memory/dreams/` as dated markdown files. Optional narrative generation via a subagent (uses existing subagent spawning).
- Replaces the current regex-based `MemoryReflector`. The existing per-turn reflection cursor (`memory-reflection.json`) is migrated to `memory-dreaming-cursor.json` for incremental migration — dreaming picks up where reflection left off (cursor value preserved, old file removed).
- **Not a port of openclaw's dreaming.** Openclaw gates promotion on a 2932-line recall store that tracks behavioral recall signals (3+ recalls across 2+ queries on multiple days). Little-goblin uses model-opinion confidence as the promotion signal, with a lightweight per-entry `recall_count`/`last_recalled_at` signal to guide budget compaction. The phase structure (light/REM/deep) and REM concept-tag aggregation are inspired by openclaw; the promotion mechanism is replaced entirely.

**Budget management (new, adapted — not ported):**
- Auto-compaction of promoted entries when memory exceeds a configurable char budget (default 50,000 chars, up from the current 6,000 hard cap).
- User-authored entries (written via `memory_write` tool) are preserved unconditionally. Only dreaming-promoted entries are eligible for compaction.
- **Recall-aware compaction order:** dreaming entries with `recall_count = 0` (never recalled by any search) are evicted first (by `promoted_at` ascending), then dreaming entries by `last_recalled_at` ascending (least-recently-recalled first), then by `promoted_at` ascending. This ensures junk promotions (model-curated but never useful) are evicted before useful entries.
- Not ported from `memory-core/src/memory-budget.ts` — openclaw's budget operates on markdown files with `## Promoted From Short-Term Memory (DATE)` sections; little-goblin's budget operates on SQLite rows with `origin = "dreaming"` and uses recall as a quality signal.

**Memory tools (modified):**
- The four existing tools (`memory_read`, `memory_read_index`, `memory_search`, `memory_write`) are merged into two tools:
  - `memory_search` — semantic + lexical hybrid search over memory entries and transcript snippets. Parameters: `query`, `limit`, `scope` (optional), `all_chats` (optional), `corpus` (`"memory"` | `"transcripts"` | `"all"`, default `"all"`). Transcript search respects `all_chats` and is restricted to the current chat by default.
  - `memory_write` — add/replace/remove/rewrite/set_description entries. Same actions as today, backed by SQLite instead of markdown files. The tool `target` (`memory` | `user` | `agent`) resolves to a database `(scope, entry_kind)` pair and is not stored literally.
- `memory_read` and `memory_read_index` are removed. `memory_search` with `corpus=memory` and no query returns the index. `memory_search` with a specific scope and no query returns that scope's entries (replaces `memory_read`).

**Snapshot (modified):**
- Stop injecting the full memory store every turn. The per-turn snapshot is replaced with:
  - A frozen summary in the system prompt at session start (bounded to 1200 chars total: active scope description + `user.md` summary + active scope `memory.md` summary + cross-scope index). Refreshed only on session creation, not per-turn.
  - Optional `## relevant memory` section via `memory_search` on the current prompt text (backed by hybrid search instead of lexical search), bounded to 3 results by default and clamped to a maximum of 5.
- The existing `[goblin memory snapshot]` per-turn aside is removed. The system prompt frozen summary replaces it.

### What is new

- SQLite-backed memory store with embeddings
- Hybrid search (vector + BM25 + concept tags + MMR + temporal decay)
- Session transcript indexing with delta sync
- Dreaming (light/REM/deep sleep phases, model-driven promotion — adapted, not ported)
- Per-entry recall tracking (`recall_count`, `last_recalled_at`) for budget compaction quality signal
- Budget management with recall-aware auto-compaction (adapted, not ported)
- `memory_scopes` table for per-scope description normalization (eliminates empty-scope `set_description` footgun — see decision `0028-memory-scopes-table`)
- FTS-only fallback on embedding provider failure
- Embedding provider (OpenAI direct)
- Two-tool memory interface (search + write)
- Memory CLI (`memory export`, `memory status`, `memory search`) for inspecting the SQLite-backed store

## Non-Goals

- **Multi-agent memory isolation.** Single user, single process. All memory belongs to one goblin.
- **Shadow databases for zero-downtime reindex.** Single process means reindex can block briefly. If memory grows large enough to need this, it is a future change.
- **Reindex locks.** Single process, synchronous SQLite. A boolean flag suffices.
- **Plugin SDK or embedding provider registry.** Direct OpenAI calls only. No multi-provider support, no plugin architecture for memory.
- **Multi-provider fallback chains.** One fallback path: `openai → fts-only`. The fallback uses a simple degraded flag with a cooldown, not a general-purpose state machine.
- **Concept vocabulary as a standalone tool.** Tags are internal to search and dreaming, not exposed to the agent or user.
- **Dreaming narrative as a user-facing feature.** The dream diary is an internal artifact for debugging and inspection. The narrative voice is optional and off by default.
- **Web UI or multi-channel memory access.** Single Telegram user only.
- **No `memory backfill` CLI command.** The transcript sync tick indexes all existing `transcript.jsonl` files on the first run after migration (when `memory_sources` is empty, every file is "changed"). This is the intended behavior — past conversations become searchable immediately. A separate `memory backfill` command is not needed.

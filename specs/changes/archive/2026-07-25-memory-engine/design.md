# memory-engine — Design

## Architecture

### Overview

The change replaces the markdown-file memory system with a SQLite-backed memory engine that includes hybrid search, transcript indexing, dreaming, and budget management. The engine adapts algorithms from OpenClaw's `memory-core` plugin (MIT) for a single-user, single-process, Bun-based agent.

**Ported algorithms (vendored under `src/memory/vendor/` with MIT headers):** `hybrid.ts`, `mmr.ts`, `temporal-decay.ts`, `concept-vocabulary.ts`. These are self-contained mathematical functions. The source is studied, imports are inlined, and the logic is reimplemented in `src/memory/`.

**Adapted components (reimplemented from scratch, not vendored):** `budget.ts` and `dreaming.ts`. OpenClaw's budget operates on markdown files; little-goblin's operates on SQLite rows. OpenClaw's dreaming uses a 2932-line recall store for promotion gating; little-goblin uses model-opinion confidence with a lightweight `recall_count`/`last_recalled_at` signal for compaction (see decision `0027-dreaming-model-driven-promotion`). The phase structure and REM concept-tag aggregation are inspired by openclaw; the promotion mechanism is replaced entirely.

### Component map

```
src/memory/
  db.ts              — SQLite database lifecycle (open, close, WAL, schema init)
  schema.ts          — table definitions, migrations, schema version
  store.ts           — CRUD over memory_entries + memory_scopes (replaces markdown store); includes `archiveOrphanTopic(chatId, topicId)` to prefix a topic scope with `archive/` on Telegram not-found errors
  embeddings.ts      — OpenAI embedding provider + cache + FTS-only fallback
  search.ts          — hybrid search (vector + BM25 + concept boost + MMR + decay); increments recall_count/last_recalled_at on returned results
  concept-vocabulary.ts — tag extraction (ported from memory-core)
  hybrid.ts          — fusion scoring, MMR, temporal decay (ported from memory-core)
  transcript-index.ts — delta sync of transcript.jsonl → memory_entries
  dreaming.ts        — light/REM/deep sleep phases, schedule integration (adapted, not ported — see decision 0027)
  dreaming-narrative.ts — optional dream diary narrative (subagent-driven)
  budget.ts          — recall-aware auto-compaction of dreaming entries (adapted, not ported)
  snapshot.ts        — frozen system prompt summary (replaces per-turn snapshot)
  context.ts         — caller-typed context assembly (preserved unchanged; call sites in `snapshot.ts`/`tool.ts` switch from `formatSnapshot` to `formatRelevantMemory` but the `MemoryCaller` type and `derivePersonaPolicy` function are unchanged)
  safety.ts          — secret/PII filter (preserved unchanged)
  quarantine.ts      — rejected candidate log (extended: add `malformed` to `QuarantineReason` union; `low_confidence` already exists in the current union)
  scope.ts           — ActiveScope → (scope, entry_kind) conversion (modified: return type changes from MemoryScope to a (scope, entry_kind) pair for SQLite)
  paths.ts           — path helpers (preserved, markdown paths become export-only)
  entry.ts           — entry metadata parsing/formatting (preserved, adapted for SQLite columns)
  tool.ts            — memory_search + memory_write tools (merged from 4 → 2)
  migration.ts       — one-shot markdown → SQLite migration on first startup
  export.ts          — SQLite → markdown export for inspectability
  cli.ts             — `memory export`, `memory status`, `memory search` commands
  mod.ts             — barrel exports
  vendor/            — vendored openclaw memory-core source (MIT headers) for algorithm reference: hybrid.ts, mmr.ts, temporal-decay.ts, concept-vocabulary.ts
```

### MemoryEngine bundle

The `MemoryEngine` is a single bundle object passed to `SchedulerLoop` and `AgentRunner` to avoid threading four separate dependencies through every constructor. It wraps the four long-lived memory components:

```typescript
type MemoryEngine = {
  database: MemoryDatabase;       // SQLite connection lifecycle
  embeddings: EmbeddingProvider;  // OpenAI embedding API + cache + FTS-only fallback
  dreaming: DreamingPipeline;     // light/REM/deep sleep phases
  transcriptIndexer: TranscriptIndexer; // delta sync of transcript.jsonl
};
```

Constructed once in `src/index.ts` at startup, after `ensureGoblinHome()` and before `SchedulerLoop` initialization. Construction order:

1. `MemoryDatabase` — open SQLite, run migration if needed.
2. `EmbeddingProvider` — construct with API key/base URL/model from env vars. The provider is NOT a lazy singleton; it is constructed eagerly at startup so that configuration errors (missing API key, invalid base URL) surface immediately rather than on first search.
3. `TranscriptIndexer` — receives `database` and `embeddings` at construction.
4. `DreamingPipeline` — receives `database`, `embeddings`, and the dispatcher/session-source seams at construction.

The `MemoryDatabase` is shared (single connection, synchronous). `AgentRunner` receives the bundle for frozen summary construction and `memory_search`/`memory_write` tool wiring (the tools use `database` for storage and `embeddings` for query embedding). `SchedulerLoop` receives it for dreaming schedule dispatch and transcript sync ticks. `search.ts`, `snapshot.ts`, `transcript-index.ts`, and `dreaming.ts` receive `embeddings` via the bundle or constructor injection — never via a hidden module-level singleton.

### Data flow

**Write path (manual — `add`):**
1. Agent calls `memory_write({action: "add", target: "memory", content: "..."})`.
2. `tool.ts` resolves the active `(scope, entry_kind)` pair from the session's `(chatId, topicId)` and the tool `target`.
3. `safety.ts` checks the content. If unsafe, reject.
4. `store.ts` opens a SQLite transaction and inserts the entry into `memory_entries` with `origin = "user"` and the resolved `scope`/`entry_kind`.
5. `store.ts` inserts a corresponding row into `memory_index_fts` (text, entry_id, scope, entry_kind, chat_id) within the same transaction.
6. `embeddings.ts` embeds the entry text and stores in `memory_embeddings`.
7. `concept-vocabulary.ts` extracts tags and stores in `memory_entry_tags`.
8. `budget.ts` checks the global budget (counting only `text` columns). If over, compacts dreaming entries (deleting their `memory_entries`, `memory_index_fts`, `memory_embeddings`, and `memory_entry_tags` rows in the same transaction). If still over, the transaction rolls back and the write fails.
9. Transaction commits.

**Write path (manual — `replace`/`rewrite`):**
1-3. Same as `add` (resolve scope, safety check).
4. `store.ts` opens a transaction and locates the existing entry by `old_text` substring match (`replace`) or by scope + most recent entry (`rewrite`).
5. `budget.ts` computes the **net change**: `postTotal = currentTotal - oldEntry.text.length + newContent.length`. If `postTotal > budget`, attempt compaction of dreaming entries. If still over, roll back and fail with overflow error. The original entry SHALL remain unchanged on failure.
6. `store.ts` deletes the old FTS row (`DELETE FROM memory_index_fts WHERE entry_id = ?`), updates `memory_entries.text`/`updated_at`, inserts the new FTS row, re-embeds (if text hash changed), and recomputes `memory_entry_tags` — all within the same transaction.
7. Transaction commits.

**Write path (manual — `remove`):**
1-3. Same as `add` (resolve scope, safety check not required for removal).
4. `store.ts` opens a transaction, deletes the FTS row, deletes `memory_entry_tags`, deletes `memory_embeddings`, and deletes the `memory_entries` row — all within the same transaction.
5. Transaction commits. Budget check is not required (removal only frees space).

**Write path (manual — `set_description`):**
1-3. Same as `add` (resolve scope, description safety check).
4. `store.ts` opens a transaction and upserts a single row in `memory_scopes` (scope, description, updated_at). No `memory_entries` changes. No FTS, embedding, or tag changes. No budget check — `description` is not counted toward the budget. This works even when the scope has zero entries (the `memory_scopes` row is independent of `memory_entries`).
5. Transaction commits.

**Write path (dreaming):**
1. Scheduler dispatches a light sleep turn to the dreaming session.
2. `dreaming.ts` reads transcript entries after the cursor, filtered to the lookback window (default 24 hours). The effective range is `max(cursor, now − lookback)` to `now`. If the cursor is older than the lookback window, only entries within the lookback window are processed.
3. `dreaming.ts` spawns a subagent with a focused extraction prompt.
4. Subagent returns structured candidates (category, confidence, text). The response is parsed by extracting the first fenced JSON code block; malformed output (non-JSON, missing required fields, invalid enum values) is appended to `quarantine.jsonl` with reason `malformed`.
5. `dreaming.ts` filters candidates with `category = "skip"` or `confidence` below the configured threshold; these are appended to `quarantine.jsonl` with reason `low_confidence`.
6. `dreaming.ts` dedupes remaining candidates against existing entries via cosine similarity (threshold 0.85). Near-duplicate candidates update the existing entry (preserving `created_at` and `source_session`, refreshing `updated_at` and `updated_source_session`) rather than inserting a new row.
7. Novel candidates pass through `safety.ts` and are inserted with `origin = "dreaming"`.
8. `budget.ts` compacts if needed.
9. Cursor advances. Dream diary entry is written.

**Search path:**
1. Agent calls `memory_search({query: "...", limit: 10, corpus: "all"})`.
2. `search.ts` resolves eligible scopes (same-chat topics, personas per caller kind). Transcript entries are filtered by `chat_id` matching the caller's chat (unless `all_chats=true` or the caller has no `chat_id`).
3. `embeddings.ts` embeds the query (or returns degraded state).
4. `search.ts` runs vector search (cosine on `memory_embeddings`) and lexical search (BM25 on `memory_index_fts`) in parallel.
5. `hybrid.ts` fuses results with weighted scoring: `score = vectorWeight * vectorScore + textWeight * textScore + conceptBoost`. Default weights are `vectorWeight = 0.7`, `textWeight = 0.3`, configurable via `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT` (clamped to [0, 1]).
   - **BM25 normalization:** `textScore = 1/(1+rank)` for non-negative ranks; `relevance/(1+relevance)` where `relevance = -rank` for negative ranks; non-finite → `1/1000`.
   - **Concept boost:** `conceptBoost = min(0.1 * matchingTagCount, 0.3)` added to fused score before decay.
6. `hybrid.ts` applies temporal decay: `decayedScore = score * exp(-ln(2) * ageInDays / halfLifeDays)`, half-life default 30 days, configurable via `GOBLIN_MEMORY_TEMPORAL_HALFLIFE_DAYS`. Entries with no resolvable `updated_at` receive no decay.
7. `hybrid.ts` applies MMR re-ranking if results exceed 2× limit: scores min-max normalized to [0,1], `mmrScore = lambda * normalizedRelevance - (1-lambda) * maxJaccardSimilarity`, lambda default 0.7, Jaccard on tokenized entry text, iterative selection with original decayed score as tiebreaker.
8. Results are returned with scope, source, score, component scores, and entry text per the `SearchResult` schema in the spec.
9. **Recall tracking:** `search.ts` increments `recall_count` and updates `last_recalled_at` on every returned `memory_entries` row (not transcript rows — transcript snippets are not subject to budget compaction). This is a cheap follow-up write after the search read completes. The recall signal drives budget compaction order (see `budget.ts`).

**Transcript sync path:**
1. Scheduler tick (every 5 min) calls `transcript-index.ts`.
2. `transcript-index.ts` scans `state/sessions/*/transcript.jsonl`.
3. Compares path, mtime, size, and hash against `memory_sources` table.
4. Changed files: parse via `transcript.ts`, chunk via the new chunking helper, embed each chunk, insert into `memory_entries` with `scope = "transcript/<sessionId>"`, `entry_kind = "transcript"`, and `chat_id` resolved from the session directory. Insert corresponding FTS rows into `memory_index_fts` within the same transaction. `transcript-index.ts` reads `state/sessions/<sessionId>/state.json` and extracts the `chatId` from the persisted `ChatLocator` binding (or falls back to the `chat_id` stored in the session state). If no chat id can be resolved, the transcript is indexed with `chat_id = null` and is excluded from chat-scoped search.
5. Deleted sessions: remove their `memory_entries`, `memory_embeddings`, `memory_index_fts`, `memory_entry_tags`, and `memory_sources` rows within a single transaction per session.
6. Update `memory_sources` with new mtime/size/hash.

**Session start path:**
1. `AgentRunner` creates a new session.
2. `snapshot.ts` builds a frozen summary from `memory_entries` (active scope description + `user.md` summary + active scope summary + cross-scope index, bounded to 1200 chars, with cross-scope index trimmed first and then summaries truncated at word boundaries if over budget). The frozen summary begins with the header `[goblin memory summary (frozen at session start)]` and includes the guardrail text `Memory may be stale or incomplete. Current user messages, recent tool results, and explicit instructions override memory.` when memory is non-empty.
3. The frozen summary is appended to `_baseSystemPrompt`.
4. Per-turn: `snapshot.ts` computes `## relevant memory` via `search.ts` on the prompt text with `corpus = "memory"` (transcript entries are excluded), default 3 results, max 5, and injects as a `nextTurn` aside.

### State management

- **SQLite database** (`$GOBLIN_HOME/state/memory/memory.sqlite`): canonical store. WAL mode for concurrent read/write. Single `bun:sqlite` connection (synchronous, in-process).
- **Dream diary** (`$GOBLIN_HOME/state/memory/dreams/<date>.md`): human-readable markdown, one file per day. Not indexed, not searched — inspection only.
- **Dreaming cursor** (`$GOBLIN_HOME/state/sessions/<id>/memory-dreaming-cursor.json`): per-session cursor recording which transcript entries have been processed by light sleep. On first observation of a session with no cursor file, the cursor is seeded to the current transcript end (no backfill). If the legacy `memory-reflection.json` exists, its cursor value is migrated to `memory-dreaming-cursor.json` (same line offset) and the old file is removed.
- **Quarantine** (`$GOBLIN_HOME/state/memory/quarantine.jsonl`): preserved format; extended to record low-confidence and `skip` candidates with reason `low_confidence`.
- **`memory_meta.reindexing` flag**: boolean key in `memory_meta` set to `"true"` while a model-change or full reindex is running and cleared to `"false"` on completion. The flag prevents concurrent reindex passes and is checked on startup. On startup, if the flag is `"true"` (left over from a crash), the system resets it to `"false"` since no concurrent process can be running. **Search during reindex:** while `reindexing = "true"`, `memory_search` SHALL use the existing (potentially stale) embeddings for vector search. This is acceptable because the reindex is updating embeddings in-place; the worst case is a transient ranking inconsistency during the reindex window (seconds to minutes for a single-user store). Search SHALL NOT block or degrade to FTS-only during reindex.
- **Markdown export** (`$GOBLIN_HOME/state/memory/{user,general/topics/.../agents/...}/*.md`): read-only export surface, regenerated by `memory export` CLI.

## Decisions

### D1: SQLite via `bun:sqlite` (not `node:sqlite` + `sqlite-vec`) [decision 0020]

**Chosen:** `bun:sqlite` builtin with pure-JS cosine similarity for vector search.

**Why:** `little-goblin` runs on Bun. `bun:sqlite` is the native SQLite binding. OpenClaw uses `node:sqlite` + the `sqlite-vec` extension for native vector operations, but that stack is Node-specific and requires loading a native extension. For a single-user agent with at most thousands of entries, pure-JS cosine similarity over stored embeddings is fast enough (sub-10ms for 5000 entries). FTS5 is built into both `bun:sqlite` and `node:sqlite`.

**Trade-off:** If memory grows to tens of thousands of entries, pure-JS cosine will be slow. At that point, a future change can add a vector extension or switch to approximate nearest neighbor search. The `memory_embeddings` schema is designed to support this — embeddings are stored as blobs that can be loaded into any vector index.

**Constraints:** Embeddings are stored as `Float32Array` blobs. Cosine similarity is computed in JS by loading both vectors into `Float32Array` and computing the dot product. The embedding dimension is stored in `memory_embeddings.dims` to support model changes.

### D2: OpenAI embeddings direct (no provider registry) [decision 0021]

**Chosen:** Direct `fetch()` to OpenAI's embeddings API. No plugin registry, no multi-provider support.

**Why:** A dedicated embedding provider configuration keeps memory recall independent of the chat model provider. For a single-user agent, OpenAI's `text-embedding-3-small` is cheap ($0.02/1M tokens), fast, and good enough. The API key and base URL are sourced from memory-specific environment variables so the chat provider can be changed without breaking embeddings.

**Trade-off:** If OpenAI is down, search degrades to FTS-only. This is acceptable — the agent still works, just with lexical-only recall. The degraded state is retried after a cooldown (`GOBLIN_MEMORY_EMBEDDING_COOLDOWN_SECONDS`, default 60).

**Constraints:** The embedding model is configurable via `GOBLIN_MEMORY_EMBEDDING_MODEL`. The API key is read from `GOBLIN_MEMORY_EMBEDDING_API_KEY` and falls back to `OPENAI_API_KEY` for backward compatibility. The optional base URL is read from `GOBLIN_MEMORY_EMBEDDING_BASE_URL` and falls back to `OPENAI_BASE_URL`. If the user switches models, all embeddings are re-computed on the next reindex (detected by comparing the stored model against the configured model).

### D3: Markdown files become export-only

**Chosen:** SQLite is canonical. Markdown files are regenerated by `memory export` CLI. Direct edits to markdown are not reflected in the store.

**Why:** The markdown files were canonical because they were the store. With SQLite as the store, keeping markdown canonical would require bidirectional sync (SQLite → markdown on write, markdown → SQLite on edit), which is complex and error-prone. Export-only is simpler and still provides inspectability.

**Trade-off:** Users who manually edit `memory.md` will lose changes on the next export. The `memory export` CLI overwrites markdown files. This is documented in the CLI help.

**Migration:** On first startup with no `memory.sqlite`, existing markdown entries are parsed and inserted into SQLite. The markdown files are preserved on disk. A `memory_meta` key `migrated_at` prevents re-migration.

### D4: Frozen system prompt summary (not per-turn snapshot) [decision 0022]

**Chosen:** Memory summary is frozen into the system prompt at session creation. Per-turn injection is removed. `## relevant memory` (hybrid search on prompt text) remains as the per-turn signal.

**Why:** The per-turn snapshot re-sends the full memory store every turn, costing 1000-2000 tokens with no relevance filtering. The frozen summary is sent once (in the system prompt, prefix-cached) and the `## relevant memory` section is bounded to 3 entries. This cuts the per-turn memory tax by ~80% while improving relevance.

**Trade-off:** Mid-session memory writes don't appear in the system prompt until the next session. This is acceptable because `memory_search` is always available — the agent can actively search for fresh entries. The frozen summary is a baseline, not the full picture.

**Constraints:** The frozen summary is bounded to 1200 chars total, with the cross-scope index trimmed first and then the active scope and `user.md` summaries truncated at word boundaries if over budget. The frozen summary header is `[goblin memory summary (frozen at session start)]` and is immediately followed by the guardrail text `Memory may be stale or incomplete. Current user messages, recent tool results, and explicit instructions override memory.` when any memory source is non-empty. The `## relevant memory` section is bounded to 3 entries by default and clamped to a maximum of 5. Both use the same hybrid search backend; `## relevant memory` searches only `corpus = "memory"` so transcript entries never appear in the per-turn aside.

### D5: Dreaming replaces per-turn reflection (adapted, not ported — see decision 0027)

**Chosen:** The per-turn `MemoryReflector` (regex-based, scheduled after every `agent_end`) is replaced by scheduled dreaming phases (model-driven, run on intervals). The `AgentRunner` still advances the dreaming cursor on `agent_end` so light sleep knows what's new.

**Why:** The current reflector runs after every turn, uses regex patterns, and cannot detect themes or nuance. Dreaming runs on intervals (4h light, daily REM, daily deep), uses a model-driven extraction subagent, and includes theme detection and budget compaction. This is a strict upgrade with less per-turn overhead.

**Not a port of openclaw's dreaming.** OpenClaw's `memory-core` dreaming gates promotion on a 2932-line recall store (`short-term-promotion.ts`) that tracks behavioral recall signals: an entry only becomes durable after being surfaced by `memory_search` at least 3 times across 2 distinct queries on multiple days. Little-goblin uses model-opinion confidence (the LLM subagent's `confidence` field) as the promotion signal. This is a different architecture, not a simplification — the phase structure (light/REM/deep) and REM concept-tag aggregation are inspired by openclaw, but the promotion mechanism is replaced entirely. See decision `0027-dreaming-model-driven-promotion` for the full tradeoff analysis.

**Trade-off:** Model-opinion confidence is a single-pass judgment; recall-based confidence is accumulated behavioral evidence. Junk promotion rates will be higher than openclaw's. This is mitigated by the recall-aware budget compaction (D6): dreaming entries with `recall_count = 0` (never recalled by any search) are evicted first. Over time, the memory store converges toward entries that are both model-interesting and search-useful.

**Trade-off:** There is a delay between a conversation and memory promotion (up to 4 hours for light sleep). This is acceptable for a personal agent — the user can always say "remember this" and the `memory_write` tool persists immediately.

**Constraints:** The dreaming session is an internal session with id `__goblin_dreaming__` (not a Telegram chat). It is created lazily on first dispatch and reused. It uses the existing subagent spawning mechanism. The subagent receives a focused prompt with transcript snippets and returns a JSON array of candidates with `text`, `category`, `confidence`, `target`, and `rationale` fields. The dreaming cursor is persisted at `$GOBLIN_HOME/state/sessions/<id>/memory-dreaming-cursor.json` (per-session, line offset into `transcript.jsonl`).

REM and deep sleep aggregate concept tags and short-term entries across all sessions. Cross-session promotions target the scope where the theme or short-term entry originated most frequently. The promotion rule is: for each theme or entry, collect its origin sessions; promote to the scope associated with the highest session count; ties are broken by the most recent `updated_at`, then by scope name ascending. If the origin sessions are all from transcript scopes without a clear curated target, promote to `general`.

### D6: Global budget replaces per-file caps (adapted, not ported — recall-aware compaction)

**Chosen:** A single global character budget (default 50,000) replaces the per-file caps (4000 for memory.md, 2000 for user.md). User-authored entries are preserved during compaction; only dreaming-promoted entries are eligible for dropping. Compaction is recall-aware: dreaming entries with `recall_count = 0` are evicted first, then dreaming entries by `last_recalled_at` ascending, then by `promoted_at` ascending.

**Why:** The 6000-char total cap is the core limitation. A 50,000-char budget allows real memory growth. The compaction strategy (drop oldest dreaming entries first, preserve user entries) ensures that manually-curated facts survive while auto-promoted entries rotate naturally.

**Trade-off:** A user who writes 50,000 chars of manual entries fills the budget and dreaming promotions fail. This is unlikely for a single user but possible. The error message reports the budget and suggests consolidating.

### D7: Two tools (search + write) instead of four [decision 0023]

**Chosen:** `memory_read` and `memory_read_index` are removed. `memory_search` subsumes both: without a query + with scope → returns entries (replaces read); without a query + without scope → returns index (replaces read_index).

**Why:** Four tools cost ~712 tokens per turn in tool definitions. Two tools cost ~470 tokens (19.7% saving, as analyzed earlier). The merged interface is also cleaner — one entry point for all recall, one for all mutation.

**Trade-off:** The `memory_search` tool schema is slightly more complex (optional query, optional scope, corpus parameter). This is a minor increase in per-call complexity for a significant decrease in per-turn token cost.

### D8: AGENTS.md "No database" guardrail carve-out

**Chosen:** The AGENTS.md Guardrails section's "No database" ruling is updated to carve out the memory SQLite database. The guardrail becomes: "Atomic writes. tmp + `renameSync`. JSON for state, JSONL for logs. No database except the memory store at `$GOBLIN_HOME/state/memory/memory.sqlite`."

**Why:** The memory engine requires SQLite for hybrid search (vector + BM25), embedding caching, and transcript indexing. These cannot be efficiently implemented with JSON/JSONL files. The "No database" guardrail was written when memory was a curated markdown scratchpad — it did not anticipate a real memory engine. Decision `0015-memory-sqlite-canonical` already established SQLite as canonical for memory; this decision updates the guardrail to match.

**Trade-off:** Future features that want a database now have a precedent. This is acceptable — the carve-out is scoped to the memory store only, and any future database addition requires its own decision.

**Constraints:** The carve-out applies only to `$GOBLIN_HOME/state/memory/memory.sqlite`. No other SQLite databases or database engines are permitted. The guardrail update is recorded as decision `0018-memory-database-guardrail-carveout` via `litespec decide`.

### D9: Configurable hybrid search weights [decision 0024]

**Chosen:** Hybrid fusion weights are configurable via environment variables `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT`, defaulting to `0.7` and `0.3` respectively and clamped to `[0, 1]`.

**Why:** The default 0.7/0.3 split is a reasonable starting point for semantic recall with lexical grounding, but different deployments and embedding models may need tuning. Environment variables keep the configuration simple and avoid adding tool parameters that the agent could misuse.

**Trade-off:** Changing weights requires a restart and does not auto-refresh cached embeddings. Weights are read once at `MemoryDatabase` initialization.

**Constraints:** Weights are parsed as floats, clamped to `[0, 1]`, and normalized so that `vectorWeight + textWeight` is at least a small positive value. If both are zero after clamping, the defaults are restored.

### Architectural rulings promoted to decisions

The following standing architectural rules have been recorded as decisions via `litespec decide`:

- **REM/deep sleep cross-session promotion rule** [decision 0025]: "for each theme or entry, collect its origin sessions; promote to the scope with the highest session count; ties by most recent `updated_at`, then scope name ascending; default `general`."
- **`general` scope is shared across all DMs and supergroup-no-topic chats** [decision 0026]: all DMs and all no-topic supergroup chats resolve to `scope = "general"`. No per-chat `general` scope.

### D10: `memory_scopes` table normalizes per-scope metadata [decision 0028]

**Chosen:** Per-scope `description` is stored in a dedicated `memory_scopes` table (scope, description, updated_at), not as a column on `memory_entries`. `set_description` upserts a single row in `memory_scopes`.

**Why:** The original design stored `description` on `memory_entries` rows, duplicated across every row in the scope. This had two problems: (1) `set_description` on an empty scope (zero entries) was a silent no-op — the UPDATE touched zero rows and the description was lost; (2) dreaming inserts between a `set_description` call and the next read could carry a stale description. The `memory_scopes` table eliminates both problems: descriptions are independent of `memory_entries` rows, stored once per scope, and survive empty-scope writes.

**Trade-off:** Reads that need descriptions (frozen summary, cross-scope index, scope-entries response) require a JOIN or separate lookup. This is a minor cost for correctness.

**Constraints:** The `description` column is removed from `memory_entries`. Migration creates `memory_scopes` rows from existing markdown frontmatter descriptions. The frozen summary and cross-scope index join `memory_scopes` to `memory_entries` on `scope`.

### D11: Dreaming internal session dispatch [decision 0029]

**Chosen:** The dreaming session (`__goblin_dreaming__`) is created via `SessionManager.ensureInternal(id)` — a new method that creates a session with `chatId: 0` (sentinel), no Telegram binding, excluded from `list()`. Dreaming turns are dispatched via `TurnDispatcher.enqueueInternalTurn(session, content, onComplete, onError)` — a new method that uses no beta tools, a capture message buffer (no Telegram output), and an `onComplete(text)` return path. Both reuse the existing `schedulePrompt` per-session queue for serialization. Dreaming phases are managed by `SchedulerLoop` as separate timers, NOT registered in `ScheduleStore`.

**Why:** The existing `enqueueScheduledTurn` is Telegram-coupled (beta tools, message buffer, project dir) and fire-and-forget (no return path). The dreaming pipeline needs the model's response to parse JSON candidates. `ScheduleStore` is for user-authored schedules with binding validation and agent-source caps — dreaming phases need none of that. The subagent runner returns the assistant text but creates its own session and doesn't use the per-session queue. The new methods are the minimal seam that satisfies all constraints: per-session serialization, no Telegram coupling, return path, no `ScheduleStore` pollution.

**Trade-off:** `TurnDispatcher` and `SessionManager` each gain a method. `SchedulerLoop` gains timer management. `SchedulerSessionSource` and `SchedulerDispatcher` seams each gain a method. Test fakes need to implement the new methods. This is a small cost for clean separation.

**Constraints:** `chatId: 0` is a sentinel — Telegram chat IDs are never 0. The dreaming session's `ActiveScope` (`{ chatId: 0, topicScope: "general" }`) is never written to. The capture buffer accumulates assistant text deltas; `onComplete` is called after `runner.prompt` resolves. Overlapping dreaming phases coalesce via the per-session queue (the second call waits behind the first).

### D12: `display_order` column preserves user-authored entry order [decision 0030]

**Chosen:** `memory_entries` includes an integer `display_order` column (default `0`) that determines presentation order within a scope. `rewrite`/`replace` set `display_order` to the entry's position in the new body, preserving the original `created_at` timestamp.

**Why:** Ordering entries by `created_at` or `id` makes `rewrite`/`replace` reordering impossible without rewriting timestamps. The `rewrite` action (e.g. "reorder my notes") is meant to change presentation order, not creation history. `display_order` decouples presentation order from creation time.

**Trade-off:** Every ordered read must sort by `display_order, created_at, id` instead of just `created_at, id`. This adds a small, indexed sort key.

**Constraints:** New entries receive `display_order = MAX(existing) + 1` within their `(scope, entry_kind)`. Migration backfills `display_order` by counting earlier rows in the same scope ordered by `created_at, id`. `read`, `readEntries`, and export all sort by `display_order` first.

## File Changes

### New files

- `src/memory/db.ts` — SQLite database lifecycle. Opens `memory.sqlite`, enables WAL, creates tables on first run. Uses `bun:sqlite`. Reads `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT` on open. Sets `PRAGMA foreign_keys = ON` so `memory_embeddings.entry_id` and `memory_entry_tags.entry_id` FK constraints are enforced (FTS5 `memory_index_fts.entry_id` is a logical reference, not a FK — see schema spec note).
- `src/memory/schema.ts` — Table definitions (memory_entries with `chat_id`, `recall_count`, `last_recalled_at`, and `display_order` columns and NO `description` column; memory_scopes for per-scope descriptions; memory_embeddings; memory_index_fts as contentful FTS5 virtual table with columns text/entry_id/scope/entry_kind/chat_id; memory_sources; memory_meta; memory_entry_tags) with exact DDL, primary keys, and required `memory_meta` keys. Schema versioning and migrations. `memory_meta` keys include `reindexing` (boolean string, set during model-change reindex, cleared on completion, reset to `"false"` on startup if stale).
- `src/memory/embeddings.ts` — OpenAI embedding provider. `embedQuery(text)`, `embedBatch(texts[])`, cache by hash, FTS-only fallback with cooldown from `GOBLIN_MEMORY_EMBEDDING_COOLDOWN_SECONDS` (default 60). API key from `GOBLIN_MEMORY_EMBEDDING_API_KEY` (fallback `OPENAI_API_KEY`); base URL from `GOBLIN_MEMORY_EMBEDDING_BASE_URL` (fallback `OPENAI_BASE_URL`); model from `GOBLIN_MEMORY_EMBEDDING_MODEL`. Constructed eagerly at startup as part of the `MemoryEngine` bundle (not a lazy singleton).
- `src/memory/concept-vocabulary.ts` — Tag extraction. Ported from `extensions/memory-core/src/concept-vocabulary.ts` (vendored under `src/memory/vendor/` before build). Inlines the one `string-coerce-runtime` import. Enforces the 8-tag-per-entry cap (keep highest-scoring on overflow). ~500 lines.
- `src/memory/hybrid.ts` — Fusion scoring, MMR, temporal decay, concept boost. Ported from `extensions/memory-core/src/memory/hybrid.ts` + `mmr.ts` + `temporal-decay.ts` (vendored under `src/memory/vendor/` before build). Adds concept tag boost (`min(0.1 * matchingTagCount, 0.3)`). Inlines imports. ~350 lines.
- `src/memory/transcript-index.ts` — Delta sync of transcript files into SQLite. Scans `state/sessions/`, compares against `memory_sources`, chunks and embeds changed transcripts. For each session, reads `state/sessions/<sessionId>/state.json` to resolve `chat_id` from the persisted `ChatLocator` binding.
- `src/memory/dreaming.ts` — Light/REM/deep sleep phases (adapted, not ported — see decision 0027). Reads transcript after cursor (`memory-dreaming-cursor.json`), spawns extraction subagent that returns JSON candidates (`text`, `category`, `confidence`, `target`, `rationale`), quarantines malformed/low-confidence/skip candidates, dedupes and consolidates remaining candidates against existing entries (preserving `created_at`/`source_session`, refreshing `updated_at`/`updated_source_session`), promotes novel candidates, compacts. REM/deep sleep aggregate across scopes and promote to the scope with the most frequent origin session (ties by most recent `updated_at`, then scope name ascending; default to `general`). Dispatched to internal session `__goblin_dreaming__`. Integrates with scheduler.
- `src/memory/dreaming-narrative.ts` — Optional first-person dream diary generation via subagent. Off by default.
- `src/memory/budget.ts` — Recall-aware auto-compaction (adapted, not ported). Counts characters in `memory_entries.text` across rows with `entry_kind = "memory"` or `entry_kind = "user"` and drops `origin = "dreaming"` entries in recall-aware order: `recall_count = 0` first (by `promoted_at` ascending), then `last_recalled_at` ascending, then `promoted_at` ascending. Handles net-change semantics for `replace`/`rewrite`. ~120 lines.
- `src/memory/migration.ts` — One-shot markdown → SQLite migration on first startup. Parses existing `user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, `agents/<name>/memory.md`, maps each file to a `(scope, entry_kind)` pair, inserts entries into SQLite. Creates `memory_scopes` rows from markdown frontmatter descriptions.
- `src/memory/export.ts` — SQLite → markdown export. Writes entries with `entry_kind = "memory"` or `entry_kind = "user"` back to the existing directory structure (`user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`, `agents/<name>/memory.md`). Writes `memory_scopes` descriptions as YAML frontmatter. Entries with `entry_kind = "transcript"` or `scope` prefixed with `archive/` are not exported.
- `src/memory/dreaming.test.ts` — Tests for dreaming phases.
- `src/memory/embeddings.test.ts` — Tests for embedding provider and fallback.
- `src/memory/hybrid.test.ts` — Tests for fusion scoring, MMR, temporal decay.
- `src/memory/concept-vocabulary.test.ts` — Tests for tag extraction.
- `src/memory/transcript-index.test.ts` — Tests for delta sync.
- `src/memory/budget.test.ts` — Tests for auto-compaction.
- `src/memory/migration.test.ts` — Tests for markdown → SQLite migration.
- `src/memory/db.test.ts` — Tests for database lifecycle and schema.

### Modified files

- `src/memory/store.ts` — Rewritten to use SQLite instead of markdown files. Same public interface (`MemoryStore` class with `add`, `replace`, `remove`, `rewrite`, `setDescription`, `read`, `readIndex`). Internally backed by `db.ts`. The `MemoryCap` constants (4000/2000) are removed; the global budget from `budget.ts` replaces them. `setDescription` upserts into `memory_scopes` instead of updating `memory_entries` rows (works on empty scopes). `read` and `readIndex` join `memory_scopes` to surface descriptions. Adds `archiveOrphanTopic(chatId, topicId)` which updates all `memory_entries` rows for the topic scope by prefixing `scope` with `archive/` (no filesystem move in SQLite).
- `src/memory/search.ts` — Rewritten to use hybrid search (vector + BM25 + concept boost + MMR + temporal decay) instead of lexical-only. Calls `embeddings.ts` for query embedding, `hybrid.ts` for fusion. Uses `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT` (default 0.7/0.3, clamped to [0, 1]). After results are finalized, increments `recall_count` and updates `last_recalled_at` on returned `memory_entries` rows (not transcript rows). The `searchMemoryEntries` function signature changes to accept a `MemoryDatabase` instead of a `MemoryStore`. The `PersonaPolicy` type is preserved.
- `src/memory/tool.ts` — Four tools merged into two. `createMemoryReadTool` and `createMemoryReadIndexTool` are removed. `createMemorySearchTool` is modified to accept optional `query`, `scope`, `corpus` parameters and subsume read/read_index behavior. `createMemoryWriteTool` is modified to resolve the tool `target` (`memory` | `user` | `agent`) to a database `(scope, entry_kind)` pair and write via the SQLite-backed store. Tool schemas are updated.
- `src/memory/snapshot.ts` — `formatSnapshot` is replaced with `formatFrozenSummary` (bounded summary for system prompt) and `formatRelevantMemory` (hybrid search on prompt text for per-turn aside). The header is `[goblin memory summary (frozen at session start)]`; non-empty summaries include the guardrail text `Memory may be stale or incomplete. Current user messages, recent tool results, and explicit instructions override memory.`. `formatRelevantMemory` searches `corpus = "memory"` so transcript entries never appear in the per-turn aside. The `MemorySnapshotPayload` type is preserved for the relevant-memory aside.
- `src/memory/entry.ts` — Entry metadata parsing is adapted for SQLite columns. The `formatReflectedEntry` and `parseEntryMetadata` functions are simplified — metadata is now stored in columns, not inline comments. Legacy entries (migrated from markdown) are preserved with null metadata.
- `src/memory/scope.ts` — The `ActiveScope → MemoryScope` conversion is modified to return a `(scope, entry_kind)` pair instead of a `MemoryScope` with a markdown path. The return type changes from `MemoryScope` to `MemoryScopePair` (or similar) containing `scope: string` and `entry_kind: "memory" | "user"`. This is the single home for the conversion; all consumers (`store.ts`, `tool.ts`, `snapshot.ts`, `search.ts`) import from here.
- `src/memory/mod.ts` — Barrel exports updated. `MemoryStore` export changes to the SQLite-backed version. New exports: `MemoryDatabase`, `formatFrozenSummary`, `formatRelevantMemory`, `DreamingPipeline`, `TranscriptIndexer`. Removed exports: `createMemoryReadTool`, `createMemoryReadIndexTool`.
- `src/memory/paths.ts` — Path helpers are preserved. `memoryDir`, `userPath`, `scopeMemoryPath` now point to export-only markdown paths. New: `memoryDbPath` (returns `$GOBLIN_HOME/state/memory/memory.sqlite`), `dreamsDir` (returns `$GOBLIN_HOME/state/memory/dreams/`).
- `src/agent/mod.ts` — `AgentRunner` construction changes: `MemoryStore` is replaced with `MemoryDatabase` (wraps SQLite). The per-turn full snapshot injection is removed. A frozen summary is added to `_baseSystemPrompt` at session creation. The per-turn `## relevant memory` section (`formatRelevantMemory` + `sendCustomMessage`) is computed before each `prompt()`. The `memoryReflector` field is replaced with a `dreamingPipeline` field. The `agent_end` handler stops scheduling reflection and instead advances the cursor. Memory tool registration changes from 4 tools to 2.
- `src/subagents/execution.ts` — Same changes as `src/agent/mod.ts` for subagent context: `MemoryStore` → `MemoryDatabase`, 4 tools → 2 tools, `formatSnapshot` → `formatRelevantMemory`, frozen summary in system prompt.
- `src/scheduler/loop.ts` — The scheduler loop gains two new dispatch types: dreaming phases (light/REM/deep) and transcript sync. Dreaming phases are managed as separate timers via `clock.setInterval` (NOT registered in `ScheduleStore`). The `SchedulerLoop` constructor gains a `memoryEngine` dependency (a single `MemoryEngine` bundle object wrapping `MemoryDatabase` + `DreamingPipeline` + `TranscriptIndexer`). On each dreaming timer fire, the loop calls `dreamingPipeline.runLightSleep()` / `runRemSleep()` / `runDeepSleep()`. The `SchedulerSessionSource` seam gains `ensureInternal(id: string): SessionState`. The `SchedulerDispatcher` seam gains `enqueueInternalTurn(session, content, onComplete, onError)`. For REM and deep sleep, the first dispatch is aligned to the configured local time (03:00 / 04:00) by computing the next occurrence after startup; subsequent dispatches are spaced by the interval. Light sleep starts from the first tick after startup. `stop()` clears all dreaming timers alongside the tick timer.
- `src/sessions/manager.ts` — Gains `ensureInternal(id: string): SessionState` method: creates a session with fixed id, `chatId: 0` (sentinel), no binding. Idempotent. `list()` skips sessions with `chatId === 0` (alongside the existing `archive/` skip).
- `src/orchestration/dispatcher.ts` — Gains `enqueueInternalTurn(session, content, onComplete, onError)` method: creates a runner with no beta tools (empty array) and a capture message buffer (accumulates assistant text, no Telegram output). Calls `schedulePrompt` for per-session serialization. `onComplete(text)` is called after `runner.prompt` resolves with the accumulated assistant text.
- `src/sessions/transcript.ts` — New `chunkTranscriptEntry(entry, maxChars)` helper. Takes a `TranscriptEntry` and returns bounded text snippets for the transcript indexer. Skips entries with <8 chars displayable text. Skips tool-result entries with no displayable text.
- `src/index.ts` — Composition root changes: construct `MemoryDatabase`, run migration if needed, construct `DreamingPipeline` and `TranscriptIndexer`, pass to `SchedulerLoop` and `AgentRunner`.

### Deleted files

- `src/memory/reflector.ts` — Replaced by `dreaming.ts`. The regex-based reflection pipeline is removed entirely.
- `src/memory/reflector.test.ts` — Replaced by `dreaming.test.ts`.
- `src/memory/store.test.ts` — Replaced by `db.test.ts` and new `store.test.ts` (tests the SQLite-backed store).
- `src/memory/search.test.ts` — Replaced by `hybrid.test.ts` and new `search.test.ts` (tests the hybrid search integration).
- `src/memory/snapshot.test.ts` — Replaced by new `snapshot.test.ts` (tests frozen summary and relevant memory).
- `src/memory/tool.test.ts` — Replaced by new `tool.test.ts` (tests the 2-tool interface).

### CLI changes

- `src/memory/cli.ts` (new file) — Shell-level CLI entry point for memory inspection. There is no existing `memory` CLI today; AGENTS.md references to `memory export` and `memory status` are aspirations that this change finally implements. The new module provides: `memory export` (calls `exportToMarkdown`), `memory status` (shows database size, entry count, embedding provider status, last sync time), and `memory search <query>` (uses hybrid search). Invoked via `bun run src/memory/cli.ts <command> [args]`.

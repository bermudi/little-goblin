---
id: 0047
date: 2026-08-23
status: accepted
spine: false
amends: [0027]
builds_on: [0015]
---

# 0047: Memory Lifetimes Follow Semantic Durability

## Status

accepted

## Context

Decision 0015 made SQLite canonical for memory and declared markdown export-only. Decision 0027 gave the dreaming pipeline model-driven promotion, lightweight `recall_count`/`last_recalled_at`, and post-search recall updates. A lifecycle review found that the accepted mechanics did not preserve the semantic distinction between durable and transient memory, while audit artifacts had no bounded lifetime.

Temporal decay was being applied to every memory result with a timestamp, including durable curated categories and uncategorized legacy entries. Deep sleep promoted every `short_term` row indiscriminately, so the category had no transient lifetime. The dream diary read and rewrote the whole file through tmp/rename for each line instead of using append mode, and the replacement omitted `fsync`. Quarantine was append-only but had no rotation or retention policy, and its path construction lived outside `paths.ts`. Recall statistics were mutated directly from `search.ts` using a mixed named-and-positional parameter style. A dead public `advanceCursor` path existed in `DreamingPipeline` even though the cursor is owned by light sleep.

## Decision

### Semantic durability and temporal decay

Temporal score decay applies only to transient entries. The default half-life is **30 days** and is configurable via `GOBLIN_MEMORY_TEMPORAL_HALFLIFE_DAYS`.

- `"off"` (case-insensitive) disables decay.
- `0` disables decay.
- Any positive number sets the half-life in days.
- Unset, empty, invalid, or negative values fall back to the default 30-day half-life.

Eligible entries for decay are:
- all `transcript` entries;
- curated `memory`/`user` entries whose `category` is `short_term`.

Durable curated categories (`fact`, `standing_order`, `commitment`, themes, and any other non-`short_term` category) and uncategorized legacy curated entries MUST NOT decay.

### Conservative short-term promotion and expiration

Short-term promotion is owned by `MemoryStore.applyShortTermLifecycle` and is called by `DreamingPipeline.runDeepSleep`. A `short_term` row is promoted to `fact` only when **all** of the following are true:

- `entry_kind` is `memory` or `user`;
- at least 24 hours have elapsed since its `updated_at`;
- `confidence >= 0.8`;
- `recall_count >= 2`.

A `short_term` row that does **not** qualify is deleted when it is older than 7 days since its `updated_at`. Younger qualifying rows and younger unqualified rows are preserved in `short_term`.

Promotion sets `category = 'fact'`, `promoted_at` to the run timestamp, and `updated_at` to the run timestamp. Deletion is a single `MemoryStore` transaction that removes the dependent `memory_index_fts`, `memory_entry_tags`, and `memory_embeddings` rows before removing the `memory_entries` row. The method returns the count of promoted and expired entries; `DreamingPipeline` logs and appends these counts to the diary.

### Audit artifact lifecycle

Memory audit artifacts are owned by one narrow module, `MemoryArtifactStore` in `src/memory/artifacts.ts`. Path construction belongs in `src/memory/paths.ts`.

- The active quarantine file is `quarantine.jsonl` under `$GOBLIN_HOME/state/memory/`.
- Quarantine is append-only: one JSONL record per write, using `O_APPEND`.
- When the UTC day changes, the active quarantine file is rotated to `quarantine-<date>.jsonl`; if that name already exists, a unique integer sequence suffix is appended (`quarantine-<date>-<n>.jsonl`).
- Rotated quarantine artifacts and daily dream-diary files are retained for **45 days**, then pruned.
- Daily diary files live at `$GOBLIN_HOME/state/memory/dreams/<date>.md`; each diary append is a single line written in append mode.
- Non-`ENOENT` filesystem errors propagate.

### Recall statistics

`MemoryStore` owns the SQL mutation for recall statistics. Search identifies the curated result ids and defers `store.updateRecallStats(ids)` via `setImmediate`, exactly as before. The store deduplicates ids, uses one consistent positional parameter style, and logs (but does not throw) any failure because results have already been returned.

### Dead cursor path

The public `DreamingPipeline.advanceCursor`, private `advanceCursorNow`, and `SessionState.pendingAdvance` state are removed, along with the unreachable deferred `finally` branch and the misleading comment. Light sleep continues to own the cursor via `processSession`/`writeCursor`. The `runLightSleep` session state tracks only `running` and `pending`.

### Light sleep backlog draining

`DreamingPipeline.processSession` captures the unread transcript lines once at invocation start and drains that finite snapshot by invoking the extractor on successive batches of at most `maxModelLines` lines. Lines appended after the snapshot are left for a later invocation. The lookback filter is applied first, then the batch is capped to `maxModelLines`. After each batch the cursor advances past the processed lines. Lines that fall outside the lookback window are skipped and recorded: a structured warning is emitted and the `memory_dreaming_expired_lines_total` metric is incremented by the number of skipped lines. Eligible lines present in the captured snapshot are never left waiting for another scheduled pass.

### Search diversity target

`searchMemoryEntries` accepts an internal `mmrLimit` argument that represents the diversity/selection target for MMR re-ranking. It defaults to the returned result `limit`. MMR is applied whenever the merged candidate count exceeds `mmrLimit`, allowing small final selections to be diversified while still fetching a wider net. The per-turn relevant-memory builder passes its actual final relevant-memory limit as `mmrLimit` while retaining `limit: 50` for post-search deduplication.

### Procedural-noise audit trail

A candidate classified as procedural noise continues to increment the `memory_dreaming_quarantine_total` metric with reason `procedural_noise`. It also appends a redacted quarantine record and a dream-diary outcome line, using the correctly resolved target scope. The rejection reason remains `procedural_noise`.

### Durable budget overflow status

`MemoryStore` owns a durable `memory_budget_blocked` marker in `memory_meta`. The marker is set after rollback on any curated `MemoryOverflowError` from `addEntry`, `updateEntry`, `addEntries`, and the `add`/`replace`/`remove`/`rewrite` mutation paths. It is cleared inside the same transaction as a successful curated write, removal, or rewrite that restores headroom. `applyShortTermLifecycle` also clears the marker when its expirations bring curated usage at or under budget. `compact()` clears the marker whenever the post-compaction total is at or under budget, including the no-op case where the store was already under budget (stale-marker reconciliation). Transcript-only writes neither enforce the curated-memory budget nor change the marker. `MemoryStore.isBudgetBlocked()` provides the canonical read path.

Dreaming records a `budget_exhausted` quarantine reason (and diary outcome) when `persistCandidate` encounters a `MemoryOverflowError`, instead of the generic `review` reason. The `QuarantineReason` union includes `budget_exhausted`.

On the next ordinary Surface-backed turn, `formatRelevantMemory` includes a hidden `## memory alert` section when the budget is blocked, even if there are no relevant search results. The alert instructs the model to tell the user that automatic memory learning is blocked and to consolidate or remove stale memory before retrying. No proactive Telegram delivery or parallel notification subsystem is added; the existing `sendCustomMessage(..., { deliverAs: "nextTurn" })` path is reused.

### Bounded embedding cache

`EmbeddingProvider.fetchedCache` is a fixed-size LRU with a 256-entry cap, implemented as a simple `Map` where accesses refresh recency and insertions evict the oldest key when at capacity.

## Consequences

Memory lifetime and ownership are now explicit: only transient entries decay, short-term entries age out deliberately, audit artifacts are append-only with bounded retention, and `MemoryStore` owns the canonical mutation surface for both lifecycle and recall. `DreamingPipeline` no longer orchestrates database internals for promotion or cursor state; its role is phase scheduling and calling the deep `MemoryStore` method.

Tests in `src/memory/hybrid.test.ts`, `src/memory/store.test.ts`, `src/memory/dreaming.test.ts`, `src/memory/search.test.ts`, `src/memory/artifacts.test.ts`, `src/memory/embeddings.test.ts`, `src/memory/quarantine.test.ts`, `src/memory/snapshot.test.ts`, and `src/agent/mod.test.ts` cover category eligibility, decay disable values, promotion/expiration branches with index cleanup, recall updates after the deferred tick, artifact append/rotation/retention/no-overwrite, the removal of the dead cursor method, light-sleep backlog draining, expired-line observability, MMR selection-target diversification, procedural-noise quarantine/diary audit, budget-blocked durable marker behavior, budget-exhausted quarantine, and the next-turn memory alert.

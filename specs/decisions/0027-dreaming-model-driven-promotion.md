# Dreaming Model-Driven Promotion

## Status

accepted

## Context

OpenClaw's `memory-core` dreaming pipeline promotes entries to durable memory using a recall-based confidence signal: an entry only becomes durable after it has been surfaced by `memory_search` at least `minRecallCount` times (default 3) across `minUniqueQueries` (default 2) distinct queries on multiple days. The confidence formula combines `averageScore`, `recallStrength`, `consolidation`, and `conceptual` weightings. This requires a persistent recall store (2932 lines in `short-term-promotion.ts`) that tracks every search hit, the days they occurred on, and the concept tags that matched.

Little-goblin is a single-user, single-process agent. Porting the full recall store — with its multi-day state, repair flows, and per-workspace ingestion machinery — would add ~3000 lines of complexity to serve one user. The cost is disproportionate.

However, without any recall signal, model-driven dreaming has a junk-promotion problem: every 4-hour light sleep pass promotes whatever the LLM finds interesting. LLMs find flashy things interesting. Over weeks, the 50k char budget fills with model-curated noise that sounds memorable but was never actually useful. Budget compaction (drop oldest dreaming entries) mitigates this but creates a treadmill — promote junk, evict junk, promote new junk.

## Decision

Little-goblin's dreaming pipeline SHALL use model-opinion confidence (the LLM subagent's `confidence` field) as the promotion signal, not OpenClaw's recall-based confidence. This is a different architecture from OpenClaw's dreaming, not a simplification of it. The phase structure (light/REM/deep) and REM concept-tag aggregation are inspired by OpenClaw; the promotion mechanism is replaced entirely.

To compensate for the absence of a recall-based gating signal, the system SHALL track a lightweight per-entry recall signal:

- `memory_entries` SHALL carry `recall_count INTEGER NOT NULL DEFAULT 0` and `last_recalled_at INTEGER` columns.
- `memory_search` SHALL increment `recall_count` and update `last_recalled_at` for every returned result within the same database transaction as the search read (or a cheap follow-up write).
- Budget compaction SHALL use recall as a quality signal: dreaming entries with `recall_count = 0` (never recalled) SHALL be evicted first (by `promoted_at` ascending), then dreaming entries by `last_recalled_at` ascending (least-recently-recalled first), then by `promoted_at` ascending.

This gives the budget compaction a quality signal without the full recall store. Entries that are promoted but never surfaced by any search are the first to be evicted. Entries that are recalled frequently survive longer.

## Consequences

**Easier:** No 3000-line recall store. No multi-day state management. No repair flows for corrupted recall data. Dreaming implementation is ~500 lines instead of ~3500.

**Harder:** The promotion signal is lower quality than OpenClaw's recall-based gating. Model-opinion confidence is a single-pass judgment; recall-based confidence is accumulated behavioral evidence. Junk promotion rates will be higher.

**Mitigated by:** The recall-count compaction signal ensures that junk entries (promoted but never recalled) are evicted first. Over time, the memory store converges toward entries that are both model-interesting and search-useful. The 50k char budget with recall-aware compaction acts as a quality filter.

**Future upgrade path:** If junk promotion remains a problem, a future change can add a promotion threshold based on `recall_count` (e.g. only keep dreaming entries with `recall_count >= 2` after a grace period). The `recall_count` and `last_recalled_at` columns provide the foundation for this without a schema migration.

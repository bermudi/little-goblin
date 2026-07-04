# Robust Memory

## Motivation

Goblin's scoped memory store is mechanically healthy: files are scoped, capped, atomically written, versioned with git, and injected per turn. After real local/work usage, though, the live store is mostly topic descriptions with very few durable entries and no `user.md`. The current system relies on the main agent deciding to call `memory_write` during a user-facing turn, so memory curation is safe but too passive.

A more useful personal agent needs a memory lifecycle, not just a memory file API:

- harvest high-signal facts from completed turns without blocking the chat,
- reject secrets, PII, procedural noise, and low-confidence guesses before persistence,
- consolidate new facts into the existing scoped files instead of appending stale duplicates,
- preserve provenance so later reviews can answer where a fact came from,
- keep injected memory visibly auxiliary and stale-prone rather than authoritative.

This change upgrades Goblin from explicit-only curated notes to a robust, guarded memory pipeline while keeping the file-first, single-process, Telegram-native architecture.

## Scope

Affected capabilities: `memory`, `agent`, and `subagents`.

This change introduces:

- A background memory reflection pass after completed main-agent turns.
- A persistent reflection cursor so each new transcript entry is processed at most once per session after the feature is enabled; first observation of an existing session seeds the cursor to the current transcript end rather than backfilling history.
- Candidate extraction from recent transcript entries into structured memory candidates.
- Deterministic prefilters for secrets/PII, procedural commands, tiny fragments, low-confidence candidates, and obvious noise before any write.
- Memory entries with lightweight metadata embedded in Markdown: `created_at`, `updated_at`, `source_session`, and confidence/category tags.
- Consolidation behavior that prefers replacing/rewriting existing entries over appending near-duplicates.
- A memory quarantine file for rejected or unsafe candidates that deserve human/agent review but must not be injected as trusted memory.
- Snapshot wording that marks memory as possibly stale/incomplete and states that current user messages and tool results override memory.
- A shared memory safety layer invoked by both the explicit `memory_write` tool and the reflection pipeline.
- Tests for extraction, filtering, redaction, cursoring, consolidation, snapshot wording, and subagent non-participation.

The reflection pipeline writes only to the active main-agent memory scope and global `user.md`; named-agent persona memory remains explicit/manual for this change.

## Non-Goals

- No vector database, embeddings, semantic search service, or SQLite/Postgres memory backend.
- No migration to a 15–25 file hierarchical memory tree. Goblin keeps the current scoped files and descriptions.
- No automatic reflection for subagent transcripts in this change. Subagents may continue to use explicit memory tools, but background reflection is main-agent-only until its write semantics are proven.
- No cross-process locking. The existing single-process homelab assumption remains.
- No Telegram UI for browsing or approving memory candidates.
- No automatic import/backfill of all historical transcripts. A follow-up can add an explicit one-shot backfill command once the live reflection behavior is trusted.
- No deletion of existing memory contents during rollout. Existing files remain valid and are gradually consolidated by future writes.

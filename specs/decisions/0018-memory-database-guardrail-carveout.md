# Memory Database Guardrail Carveout

## Status

accepted

## Context

The AGENTS.md Guardrails section states: "Atomic writes. tmp + `renameSync`. JSON for state, JSONL for logs. No database." This guardrail was written when the memory system was a curated markdown scratchpad with lexical substring search.

The `memory-engine` change replaces the markdown scratchpad with a SQLite-backed memory engine that includes hybrid search (vector + BM25), embedding caching, transcript indexing, and dreaming. These capabilities cannot be efficiently implemented with JSON/JSONL files. Decision `0015-memory-sqlite-canonical` already established SQLite as the canonical store for memory; this decision updates the guardrail to match.

## Decision

- The AGENTS.md "No database" guardrail SHALL be updated to: "Atomic writes. tmp + `renameSync`. JSON for state, JSONL for logs. No database except the memory store at `$GOBLIN_HOME/state/memory/memory.sqlite`."
- The carve-out applies only to the memory SQLite database. No other SQLite databases or database engines are permitted without a separate decision.
- SQLite transactions provide atomicity for the canonical memory store; tmp + rename remains the atomicity mechanism for markdown export files and all other state.

## Consequences

- Future features that want a database now have a precedent. This is acceptable — the carve-out is scoped to the memory store only, and any future database addition requires its own decision.
- The AGENTS.md Guardrails section must be updated as part of the `memory-engine` implementation (Phase 0 task).

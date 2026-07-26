# transcript-surface-provenance

## Motivation

A captured runtime knows which Surface produced its work, but the current transcript and memory-index seams discard that fact. Indexing assigns one chat to an entire transcript from legacy session metadata, and dreaming promotes against a session-level scope. After a Conversation moves, those shortcuts can expose old entries in the wrong default chat or promote them into the wrong topic memory.

Decision 0037 requires event-time provenance instead: each user-visible transcript entry records the producing runtime's canonical SurfaceId, each indexed chunk derives its chat from that entry, and dreaming derives durable targets from the candidate's source. Unknown legacy history must remain unknown rather than being stamped from a current binding.

## Scope

This change depends on both `telegram-surface-identity` and `surface-derived-memory-context`. It affects three capabilities: `sessions`, `memory`, and `agent`.

### Sessions

- Extend the exclusive transcript seam with optional `sourceSurfaceId` plus an explicit Surface/internal writer context.
- Require every new user-visible main-runtime and synthetic user-visible entry to carry the runtime capture's canonical SurfaceId. Internal and legacy entries omit it explicitly.
- Preserve validated provenance through parsing, display extraction, range reads, logical cursors, and chunking. Moving a Conversation never rewrites prior entries.
- Add a conservative, idempotent startup migration that backfills only from persisted historical evidence proving an event source. Current bindings and creation metadata alone are never historical guesses.

### Memory

- Persist nullable `source_surface_id` on transcript index rows and derive each chunk's existing `chat_id` from the canonical Surface codec.
- Support mixed-chat rows inside one `transcript/<conversationId>` scope; unresolved, invalid, or internal provenance indexes with null Surface/chat values.
- Invalidate every transcript row built from session-level chat metadata before enabling provenance-aware search, then rebuild through normal bounded sync.
- Preserve default same-chat search and explicit `all_chats = true`, including deliberate access to provenance-null legacy rows only through cross-chat/internal behavior.
- Derive light-, REM-, and deep-sleep promotion behavior from source provenance. Conflicting proven line ranges are quarantined; unknown provenance retains decision 0025's `general` fallback.

### Agent

- Bind every accepted user-visible transcript write to the runtime capture's `sourceSurfaceId`, including synthetic replies, without consulting a later binding.
- Remove session-state/current-binding scope inputs from dreaming and scheduler entry points.
- Keep internal model extraction Surface-free; it extracts candidates but does not provide promotion authority.

## Dependency integration

- `conversation-lifecycle` depends on this change as well as `surface-derived-memory-context`, so Conversations cannot become movable before event-time transcript provenance and the conservative index rebuild exist.

## Non-Goals

- No change to Surface-to-ActiveScope projection, frozen memory capture, memory tool authority, or subagent invocation inheritance; those are provided by `surface-derived-memory-context`.
- No guessed legacy backfill from a current binding, Conversation creation metadata alone, shared scope, or shared Execution Environment.
- No curated-memory key migration, search-ranking change, embedding-provider change, budget change, or public memory-search result schema change.
- No Conversation movement, lifecycle commands, execution-environment migration, delegated-work delivery, or reachability behavior.
- No `internal` Surface variant and no synthetic zero-chat SurfaceId.
- No canon edits in this planning change.

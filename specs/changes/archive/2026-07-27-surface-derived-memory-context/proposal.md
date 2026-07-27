# surface-derived-memory-context

## Motivation

Memory authority still crosses the legacy session seam. Main runners derive scope from `ChatLocator`, frozen summaries are tied to lazy pi-session initialization, and subagents can revive persisted scope metadata as if it were current routing authority. That becomes incorrect once a durable Conversation can receive replacement runtimes on different Telegram Surfaces.

Decision 0037 establishes the missing boundary: a validated Surface deterministically projects to `ActiveScope`, a conversation runtime captures that memory context once, and subagent invocations inherit the parent runtime's already-derived authority. The projection is runtime state, not persisted Surface configuration.

## Scope

This change depends on `telegram-surface-identity` and affects three capabilities: `memory`, `agent`, and `subagents`.

### Memory

- Make `resolveActiveScope(surface)` the sole Surface-to-`ActiveScope` projection. Every topic container maps to the existing topic scope; DM, topicless supergroup, and guest map to singleton `general` while retaining chat ID for discovery.
- Keep `ActiveScope` derived and non-persistent. Remove named-agent identity from it; caller/persona policy remains in `MemoryCaller`.
- Introduce one immutable captured runtime-memory-context seam containing canonical source `SurfaceId`, projected `ActiveScope`, caller descriptor, frozen summary, and frozen-summary deduplication inputs.
- Represent internal memory/search callers explicitly without inventing a Surface or treating `chatId: 0` as Telegram identity.
- Make frozen summary, relevant-memory assembly, scope discovery, `memory_search`, and `memory_write` consume captured context rather than locators, bindings, Conversation metadata, or caller-selected policy knobs.

### Agent

- Capture memory context when the conversation runtime is created, before lazy pi `AgentSession` initialization.
- Require `AgentRunner` to consume that completed capture for its frozen summary, per-turn relevant memory, and memory tools.
- Deduplicate concurrent asynchronous runtime creation and reject stale captures before runner registration.
- Preserve all accepted tool schemas, summary bounds, relevant-memory bounds, and caller-supplied tools.

### Subagents

- Capture each spawn from the parent invocation's immutable Surface memory authority; recursively spawned children inherit that authority while deriving their own caller identity.
- Treat revival as a new invocation using the reviving parent runtime's capture. Persisted legacy `activeScope` remains migration/diagnostic data only.
- Preserve named-agent persona separation, generic/named tool-schema parity, and ordinary caller visibility.
- Keep internal dreaming extraction on the explicit Surface-free path rather than granting it ordinary subagent memory tools.

## Non-Goals

- No transcript `sourceSurfaceId`, transcript migration, transcript index rebuild, mixed-chat transcript indexing, or provenance-driven dreaming. Those are owned by the dependent `transcript-surface-provenance` change.
- No curated-memory key migration: `general`, `topics/<chatId>/<topicId>`, `agents/<name>`, `user`, and archive keys remain unchanged.
- No persisted Surface memory setting, user-selectable scope, per-Conversation memory scope, or topic-container-specific key.
- No search ranking, embedding, budget, compaction, summary-bound, relevant-memory-bound, or persona-visibility changes.
- No Conversation movement or binding lifecycle behavior; `conversation-lifecycle` consumes the capture seam after both memory changes land.
- No `internal` Surface variant and no reinterpretation of the dreaming compatibility sentinel as Telegram identity.
- No canon edits in this planning change.

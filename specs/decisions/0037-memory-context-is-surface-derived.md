---
id: 0037
date: 2026-07-26
status: accepted
spine: false
---

# 0037: Memory Context Is Surface-Derived

## Status

accepted

## Context

Decision 0033 separates Surface and Conversation lifetimes, but its phrase “active memory-scope resolution is Surface-owned” can be read as requiring a mutable memory-scope setting persisted on each Surface. That would create a second authority beside the Surface itself and the MemoryStore’s scope keys.

The current implementation also derives memory context and transcript search provenance from legacy session metadata. A main runner resolves `ActiveScope` from a `ChatLocator`; transcript indexing assigns one `chat_id` to an entire transcript from `state.json`; and dreaming promotes against the session’s later scope. Those shortcuts fail once a Conversation can move: one transcript can contain entries produced on several Surfaces, while creation metadata and the current binding describe neither event-time provenance nor the destination runtime’s context.

Internal model runs and subagents make the boundary sharper. Internal runs have no Telegram Surface and must not fabricate one. Subagents have no independent Surface and must retain the parent runtime context they were given rather than consulting a later binding.

## Decision

The current bound Surface SHALL be the sole routing authority used to derive a main conversation runtime’s `ActiveScope`. The deterministic projection is:

- any topic Surface, regardless of `private`, `supergroup`, or `direct-messages` container, maps to the existing topic context for `(chatId, topicId)` and therefore to curated scope `topics/<chatId>/<topicId>`;
- DM, topicless supergroup, and guest Surfaces map to the singleton curated scope `general`;
- the Surface chat ID remains available in `ActiveScope` for same-chat discovery and transcript filtering even when the curated scope is `general`.

`ActiveScope` is a derived runtime value, not persisted Surface state. Surface persistence SHALL NOT contain an active-memory-scope setting, cached projection, or caller-selected override. The MemoryStore remains the owner of curated entries and scope descriptions. `Surface → ActiveScope` and `ActiveScope → MemoryScope` each have one code-owned conversion seam.

A conversation runtime SHALL capture its Surface-derived memory context when that runtime is created. Its frozen summary, active-scope tools, same-chat boundary, and per-turn relevant-memory behavior remain fixed for the runtime lifetime. Moving a Conversation disposes the old runtime; the destination runtime captures a new context from the destination Surface. Conversation creation metadata and a previous or later binding are not memory-context authority.

A subagent invocation SHALL capture the already-derived active memory context of its parent runtime. The captured context is immutable for that invocation, and recursively spawned children inherit it. A named subagent’s persona identity remains a separate caller attribute; it does not alter the Surface projection. A revived subagent is a new invocation and captures the reviving parent runtime’s current context rather than treating persisted legacy scope metadata as live routing authority.

Every new user-visible Conversation transcript entry SHALL record the canonical `sourceSurfaceId` of the runtime that produced it. The provenance is captured at event time and is never rewritten when the Conversation moves. Transcript indexing derives each chunk’s `chat_id` from that entry’s validated source Surface, so one `transcript/<conversationId>` scope may contain chunks from several chats. Dreaming derives each snippet’s promotion scope from the snippet’s source Surface projection, not from Conversation creation metadata or the Conversation’s current binding.

Internal runs have no Surface. Internal memory/search context SHALL be represented explicitly as internal, and internal transcript entries SHALL omit `sourceSurfaceId`; code MUST NOT invent an `internal` Surface, zero chat Surface, or synthetic SurfaceId. Legacy transcript entries may also lack provenance. Invalid, absent, or ambiguous legacy provenance yields `chat_id = null` and remains excluded from default chat-scoped transcript search. Decision 0025’s `general` fallback remains the deterministic promotion target when provenance cannot establish a curated target.

Existing curated scope keys, the singleton `general` scope, named-agent persona memory, same-chat defaults, explicit `all_chats = true`, frozen-summary bounds, relevant-memory bounds, and MemoryStore ownership remain unchanged.

This decision refines decisions 0016, 0022, 0025, 0026, 0029, 0031, and 0033; it does not supersede them.

## Consequences

Surface records stay smaller and avoid duplicated mutable memory authority. A moved Conversation receives destination-appropriate memory context without carrying stale tools or snapshots, while its historical transcript retains the Surface provenance of each event.

The transcript seam must accept explicit writer context, preserve optional provenance through parsing and chunking, and migrate conservatively. Existing transcript index rows derived from session-level chat metadata must be invalidated and rebuilt before they can participate in scoped search.

Subagent spawn and revival interfaces must receive captured memory context rather than resolving through `ChatLocator`, current bindings, or persisted legacy scope fields. Internal dreaming dispatch must use an explicit Surface-free path.

Legacy history cannot always be attributed safely. Migration may backfill only provenance proven by persisted historical evidence; it must never use the current binding as a guessed historical source. Unresolved entries remain searchable only through explicit cross-chat behavior and promote through the accepted `general` fallback.

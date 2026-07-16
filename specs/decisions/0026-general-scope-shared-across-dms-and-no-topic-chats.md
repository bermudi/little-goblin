# General Scope Shared Across DMs And No-Topic Chats

## Status

accepted

## Context

The `general` memory scope is used by DM sessions and supergroup sessions without a topic. Without an explicit ruling, future changes might split `general` per chat, creating isolated memory stores that would fragment recall for a single-user agent.

## Decision

The `general` scope SHALL be shared across every DM and every supergroup-no-topic chat. All DMs and all no-topic supergroup chats resolve to `scope = "general"`, `entry_kind = "memory"`. There is no per-chat `general` scope. Splitting `general` per chat would require a new decision superseding this one.

## Consequences

Memory written in one DM is recallable from any other DM and from any no-topic supergroup chat. This is intentional for a single-user agent where the user is the same person across all surfaces. If multi-user support is ever added, this ruling must be revisited.

# Transcript search scope

## Status

accepted

## Context

The memory engine indexes session transcripts for semantic search. Transcripts are not curated memory; they are raw conversation history. The default search corpus (`corpus = "all"`) mixes curated memory and transcripts.

Curated memory scopes (`user`, `general`, `topics/<chatId>/<topicId>`, `agents/<name>`) respect the current `chatId` boundary by default: topic scopes from other chats are excluded unless `all_chats=true`. The same privacy boundary should apply to transcripts, but transcript entries are keyed by `transcript/<sessionId>` rather than chat.

## Decision

- Transcript search SHALL default to the current chat's sessions.
- `memory_search` with `corpus = "all"` (the default) SHALL include transcript snippets from sessions in the current chat unless `all_chats = true`.
- `memory_search` with `corpus = "transcripts"` SHALL search only transcript snippets from the current chat unless `all_chats = true`.
- `all_chats = true` SHALL include transcript snippets from sessions in any chat.

## Consequences

- `memory_search` must resolve each session ID to its chat before searching transcripts, or store the chat alongside transcript entries.
- The default user experience does not leak one chat's conversation history into another.
- A user who wants cross-chat recall must opt in with `all_chats=true`.

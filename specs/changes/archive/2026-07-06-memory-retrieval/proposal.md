# memory-retrieval

## Motivation

Goblin already has scoped memory files, explicit read/write/index tools, per-turn snapshots, git-backed writes, safety filtering, metadata-bearing reflected entries, and deterministic background reflection. The weak spot is retrieval quality: the model can read a whole scope or list scope descriptions, but it cannot ask for the most relevant memory entries across the current chat's scopes without manually reading and scanning files.

OpenClaw's memory surface includes embedding-backed search and session memory, but Goblin should stay file-native for now. A lexical `memory_search` tool gives the agent practical recall without introducing SQLite, embeddings, vector stores, or model-based rewriting.

## Scope

This change adds file-native lexical memory retrieval.

Affected capabilities:

- `memory`: add search over existing memory files and reflected-entry metadata.
- `agent`: register the new `memory_search` tool alongside existing memory tools.

Behavior changes:

- The agent can query memory by text and receive ranked matching entries from `user.md`, the active scope, same-chat topic scopes, and relevant named-agent persona scopes.
- Search defaults to the current chat's memory universe and requires an explicit `all_chats` opt-in for cross-chat search.
- Search returns entries, not whole files, preserving the current scoped file layout and write rules.
- Memory snapshots may include a bounded relevant-memory section for the current prompt when matches are available.

New functionality:

- A deterministic lexical scorer ranks entries using normalized token overlap, exact phrase bonuses, field/category boosts, confidence metadata, and recency metadata where available.
- Search results include scope identifiers, target (`user`, `memory`, or `agent`), entry text, score, and parsed metadata when present.
- Reflection recognizes explicit commitments and standing orders as durable entry categories so later automation can search for them without inferring commitments.

## Non-Goals

- No embeddings or vector database.
- No SQLite or external memory backend.
- No transcript-wide search beyond curated memory files.
- No automatic model-based memory rewriting or dreaming.
- No arbitrary-scope memory writes.
- No inferred commitments; only explicit text that matches deterministic reflection rules may become commitment/standing-order memory.

## Existing Canon Context

This change builds on two established canon requirements without modifying them:

- `Cross-scope discovery defaults to the current chat` (canon `memory`) — search scope boundaries mirror this existing chat-scoped discovery rule.
- `AgentRunner injects memory snapshot as per-turn aside` (canon `agent`) — the snapshot extension is additive and preserves the existing injection mechanism.

These are canon baselines, not active changes, so `dependsOn` is not set in `.litespec.yaml`.

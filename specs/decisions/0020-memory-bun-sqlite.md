# Memory store uses `bun:sqlite`

## Status

accepted

## Context

The memory-engine change replaces markdown files with a SQLite-backed store. The implementation can use either `node:sqlite` with the `sqlite-vec` native extension or `bun:sqlite` with pure-JS vector operations. `little-goblin` is already a Bun project, and native vector extensions introduce extra deployment complexity for a single-user homelab agent.

## Decision

- The canonical memory database at `$GOBLIN_HOME/state/memory/memory.sqlite` SHALL use `bun:sqlite`.
- Vector search SHALL be implemented in pure JavaScript by loading stored `Float32Array` embeddings and computing cosine similarity.
- The database SHALL use WAL journal mode.
- If memory grows large enough that pure-JS cosine similarity becomes a bottleneck, a future change may add a vector extension or switch to approximate nearest-neighbor search.

## Consequences

- No native SQLite extension is required at install time.
- Embeddings are stored as `Float32Array` blobs; `memory_embeddings.dims` records the dimension for model-change validation.
- For small-to-medium memory sizes (thousands of entries), search latency remains sub-10ms.
- The schema and query code are portable to `node:sqlite` later if `bun:sqlite` becomes a constraint.

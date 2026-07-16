# Memory hybrid search fusion weights are configurable

## Status

accepted

## Context

Hybrid search fuses vector cosine similarity and BM25 lexical scores. The default 0.7/0.3 split is a reasonable starting point, but different deployments and embedding models may benefit from tuning.

## Decision

- The vector and text fusion weights SHALL be configurable via environment variables `GOBLIN_MEMORY_VECTOR_WEIGHT` and `GOBLIN_MEMORY_TEXT_WEIGHT`.
- Defaults SHALL be `0.7` for vector and `0.3` for text.
- Values SHALL be parsed as floats and clamped to `[0, 1]`.
- If both values are zero after clamping, the defaults SHALL be restored.
- Weights SHALL be read once at `MemoryDatabase` initialization.

## Consequences

- Operators can tune semantic vs lexical emphasis without code changes.
- Weight changes require a process restart.
- Cached embeddings are not invalidated by weight changes; only the fusion step is affected.

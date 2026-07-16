# Memory embedding provider is OpenAI direct

## Status

accepted

## Context

The memory engine needs an embedding provider for hybrid search. A pluggable registry would support multiple providers but adds configuration and runtime complexity. For a single-user homelab agent, a single well-supported embedding API is sufficient.

## Decision

- The embedding provider SHALL call OpenAI's embeddings API directly via `fetch()`.
- The default model SHALL be `text-embedding-3-small`.
- The API key SHALL be read from `GOBLIN_MEMORY_EMBEDDING_API_KEY` and SHALL fall back to `OPENAI_API_KEY` for backward compatibility.
- The optional base URL SHALL be read from `GOBLIN_MEMORY_EMBEDDING_BASE_URL` and SHALL fall back to `OPENAI_BASE_URL`.
- These credentials SHALL be independent of the chat provider configuration.
- The model SHALL be configurable via `GOBLIN_MEMORY_EMBEDDING_MODEL`.
- No multi-provider registry or plugin SDK is introduced.

## Consequences

- Switching the chat model provider does not affect embedding recall as long as the embedding env vars are set.
- If OpenAI is unavailable, search degrades to FTS-only ranking with a configurable cooldown.
- Future support for alternative embedding providers requires a follow-up change.

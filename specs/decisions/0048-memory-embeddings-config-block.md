---
id: 0048
date: 2026-09-04
status: accepted
spine: false
---

# 0048: Memory embeddings configured via goblin.json5

## Status

accepted

Supersedes the configuration channel of `0021-memory-openai-embedding-direct` (its env-var
fallbacks remain for backward compatibility); the OpenAI-compatible client shape it ruled on
is unchanged.

## Context

Embedding configuration (API key, base URL, model, provider label) was env-var-only
(`GOBLIN_MEMORY_EMBEDDING_*`), while every other operator-facing setting lives in
`goblin.json5`. This forced deployments to split one concern across a unit-file drop-in and
the config file, and the key could not use `resolveConfigValue()` (`!pass-cli` / env-name
resolution). It also tempted wiring the key into `openaiApiKey`, a chat-provider field whose
name promises a different upstream. Production (lithium) hit both problems while enabling
OpenRouter-hosted Perplexity embeddings.

## Decision

- `goblin.json5` SHALL accept an optional `embeddings` block:
  `apiKey`, `baseUrl`, `model`, `provider`, `cooldownSeconds` — all optional.
- Each key SHALL override its environment-variable fallback individually;
  unset keys keep falling back (`GOBLIN_MEMORY_EMBEDDING_*`, then the client defaults).
- `baseUrl` SHALL NOT include `/v1`; the client appends `/v1/embeddings`.
- `provider` SHALL be the operator-accurate upstream label (e.g. `openrouter`, `ollama`),
  stored in `memory_embeddings` and used as a reindex trigger together with `model`.
- Embedding credentials SHALL remain independent of chat provider keys; no embedding
  fallback to `openaiApiKey` is introduced.
- Values in the block SHALL resolve through `resolveConfigValue()` like all config strings.
- No multi-provider registry or plugin SDK is introduced.

## Consequences

- The whole embeddings concern is one file; the lithium systemd drop-in is retired after
  its settings move into the config block.
- Env vars keep existing deployments and CLI usage (`memory/cli.ts`) working unchanged.
- Model or provider changes still trigger a full reindex at next startup.

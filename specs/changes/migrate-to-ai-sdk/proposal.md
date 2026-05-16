## Motivation

Goblin has hit the ceiling of what pi's agent infrastructure can provide. Three concrete limitations:

1. **No provider-native tools.** OpenAI's `web_search` tool gets serialized as `{ type: "function" }` — citations, source URLs, and search metadata are silently discarded. Goblin can't take advantage of server-side web search without wiring up a separate search API and paying for it.

2. **No file attachments.** Pi's content type union is closed at `TextContent | ImageContent`. There is no way to send a PDF, document, or any binary file in model context. The workaround — save to disk and tell the model to read it via bash — doesn't work for non-text PDFs, which is most PDFs.

3. **Everything goes through bash.** Read/write/edit, file analysis, any operation that isn't text generation or image understanding requires shell execution. This is slow, fragile, and doesn't scale to richer tooling.

The root cause: pi's three packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`) form a coupled type system where the content union, tool format, and streaming function are hardcoded across all three layers. Extending any of them requires coordinated changes across all three. The research is in `specs/research/pi-ai-dependency-analysis.md`.

Replacing pi with the Vercel AI SDK gives goblin direct control over message construction, tool serialization, and provider-specific features. AI SDK's `streamText()` + `maxSteps` replaces pi's agent loop with a single function call. File attachments and native provider tools become first-class because goblin owns the message arrays.

## Scope

Replace the pi dependency stack (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`) with the Vercel AI SDK (`ai` + provider packages). This is a **complete replacement** — pi is removed from `package.json`.

### Capabilities affected

| Capability | Change |
|---|---|
| `agent` | Rewrite `AgentRunner` to use AI SDK's `streamText()` with `maxSteps` instead of pi's `AgentSession`. Own the message array and event emission. |
| `models` | Replace pi-ai's model database with AI SDK provider constructors (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `gateway()`). Maintain goblin's prefixed ID scheme (`poe/`, `or/`, `openai/`, `anthropic/`, `zai/`). |
| `pi-host` | Delete. AI SDK has no equivalent services — providers are constructed directly. Path helpers move to their callers. |
| `subagents` | Rewrite `SubagentRunner` and `execution.ts` to use AI SDK's `generateText()` / `streamText()` instead of pi's `createAgentSession()`. Keep the same lifecycle, persistence, depth capping, and named-agent isolation. |
| `beta-tools` | Replace pi's `defineTool()` with AI SDK's `tool()` helper. Switch from typebox schemas to zod schemas. |
| `memory` | Rewrite memory tools (`memory_read`, `memory_write`, `memory_read_index`) to use AI SDK's `tool()` format. |
| `sessions` | Goblin already owns session persistence (JSONL transcripts, state files). Pi's `SessionManager` was wrapping goblin's paths. Remove the pi layer, keep goblin's existing session layout. |
| `commands` | `model` and `think` commands reference pi's `ThinkingLevel` type and `clampThinkingLevel()` function. Replace with goblin-owned equivalents. |
| `orchestration` | Minor wiring changes — remove pi service construction from startup. |

### What changes for the agent (the LLM inside goblin)

- **New capabilities:** Provider-native web search (OpenAI), PDF/file attachment reasoning, any provider-specific tool goblin enables
- **Unchanged:** Memory tools, subagent spawning, session persistence, compaction, resource loading (AGENTS.md, skills), Telegram β-tools (voice, photo, document, rename topic)

### What does NOT change

- Session filesystem layout (`$GOBLIN_HOME/sessions/<id>/`)
- Memory system (`$GOBLIN_HOME/memory/`, memory tools, scoping)
- Named agent definitions (`$GOBLIN_HOME/agents/<name>/`)
- Telegram layer (grammy, message normalization, reactions, voice, files)
- Config shape (`.env` vars, `Config` interface)
- Compaction behavior (ask the model to summarize — now via AI SDK instead of pi)
- Goblin's tool surface: bash, read, write, edit, memory tools, spawn_subagent, revive_subagent, β-tools

## Non-Goals

- **No web UI, no multi-channel.** Goblin lives in Telegram.
- **No LangChain / LangGraph.** AI SDK is the replacement. Goblin's architecture doesn't need a graph model.
- **No new tools in this change.** Web search and PDF attachments unlock after the migration; wiring them up is a separate change.
- **No behavior changes.** The agent should respond the same way before and after. This is a dependency swap, not a feature change.
- **No changes to the Telegram layer.** grammy stays, message handling stays, β-tools stay.
- **No multi-user.** Still single-user, homelab.

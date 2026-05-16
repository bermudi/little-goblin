## Architecture

### Before (current)

```
goblin (AgentRunner)
  → pi-coding-agent (AgentSession)
    → pi-agent-core (Agent → agent loop)
      → pi-ai (streamSimple → provider HTTP)
  pi-host (AuthStorage, ModelRegistry, SettingsManager)
  sessions/ (goblin's own JSONL transcripts, state files)
  memory/ (goblin's own memory store)
  subagents/ (wraps pi's createAgentSession per subagent)
```

Three coupled pi packages form the LLM plumbing. Goblin wraps them through `AgentRunner` (main) and `SubagentRunner` (subagents). Session persistence, memory, and resource loading are already goblin-owned.

### After (target)

```
goblin (AgentRunner)
  → ai SDK (streamText / generateText)
    → @ai-sdk/openai | @ai-sdk/anthropic | ai (gateway)
  paths.ts (filesystem layout — replaces pi-host)
  sessions/ (unchanged)
  memory/ (unchanged)
  subagents/ (wraps AI SDK generateText per subagent)
```

The pi stack is replaced by AI SDK's `streamText()` with `maxSteps` for tool loops. Goblin owns the `ModelMessage[]` conversation history array. No pi service objects exist. Provider instances are constructed directly from API keys.

### Key data flow change

**Before:** `AgentRunner.prompt()` → `AgentSession.sendUserMessage()` → pi's internal agent loop → events via `subscribe()` → `dispatchAgentEvent()` → `TurnCallbacks`

**After:** `AgentRunner.prompt()` → assemble `ModelMessage[]` + tools → `streamText({ model, messages, tools, maxSteps })` → iterate `fullStream` → `dispatchStreamEvent()` → `TurnCallbacks`

The `ModelMessage[]` array is goblin's source of truth for conversation history. It is not managed by any external library. On each turn, goblin:
1. Loads memory snapshot → prepends as a user message
2. Appends the user's prompt
3. Calls `streamText()` with the full array
4. Appends `result.response.messages` to the array
5. Writes transcript entries to disk

### Session persistence

Pi's `SessionManager` is removed. Goblin's existing session filesystem layout (`sessions/<id>/`) stays unchanged. The `transcript.jsonl` format stays the same (JSONL with timestamped entries). Conversation history for resumption is stored as `messages.jsonl` (AI SDK `ModelMessage[]` serialized per line).

For subagents, the same pattern: `meta.json` for metadata, `messages.jsonl` for conversation history.

### Tool definitions

Pi's `defineTool()` with typebox schemas → AI SDK's `tool()` with zod schemas. The `execute` signature changes from `(toolCallId, params)` to `(params, options)` where options includes `{ abortSignal, messages }`.

The `ToolDefinition` type alias from pi → direct use of AI SDK's `Tool` type.

### Compaction

Pi's built-in compaction is replaced by goblin's own: call `generateText()` with the conversation history and a summarization system prompt, then replace the `ModelMessage[]` with a single system message containing the summary. This is what pi was doing internally anyway.

## Decisions

### D1: Own the conversation history array

**Chosen:** Goblin maintains `ModelMessage[]` in memory, persisted to `messages.jsonl`.

**Why not:** AI SDK has no session management. Using pi's `SessionManager` was already just wrapping goblin's paths.

**Constraints:** The array must be kept in sync with transcript entries. On process restart, the array is rebuilt from `messages.jsonl`.

### D2: Follow-up queue becomes goblin-owned

**Chosen:** `AgentRunner` maintains a queue of pending messages. When a turn completes, queued messages are dispatched as a new turn.

**Why not:** Pi's `followUp()` API was proprietary. AI SDK has no equivalent — each `streamText()` call is independent.

**Constraints:** The queue is in-memory only. If the process crashes mid-turn, queued messages are lost (same as pi's behavior).

### D3: Provider constructors replace pi-ai's model database

**Chosen:** Each model entry in `MODELS` specifies an AI SDK provider function and model ID string. Pattern-matched entries (e.g. `poe/<id>`) construct providers dynamically.

**Why not:** Pi-ai's `getModel()`, `getProviders()`, `getModels()` were used to resolve `maxTokens` and `thinkingLevelMap`. AI SDK providers don't have an equivalent database. Goblin hardcodes `maxTokens` per model family (this is a small, stable set) and `thinkingLevelMap` is replaced by provider-specific options.

**Constraints:** New models require manual entry in `MODELS` or a pattern-match rule. This is acceptable — goblin already had explicit registry entries.

### D4: typebox → zod for tool schemas

**Chosen:** Switch all tool schemas from typebox to zod, matching AI SDK's native format.

**Why not:** AI SDK's `tool()` helper requires zod schemas. Maintaining typebox would require a conversion layer.

**Constraints:** Memory tools, β-tools, and subagent tools all switch. The `@sinclair/typebox` dependency can be removed.

### D5: No ToolLoopAgent — use streamText directly

**Chosen:** Use `streamText()` with `maxSteps` for the main agent loop. Do not use AI SDK's `ToolLoopAgent` class.

**Why not:** `ToolLoopAgent` adds an abstraction layer (agent definition, `generate()`/`stream()` methods) that doesn't match goblin's existing architecture. Goblin already has `AgentRunner` with its own lifecycle, abort, callback dispatch, and memory injection. Using `streamText()` directly gives full control.

**Constraints:** Tool loop control (`maxSteps`, `prepareStep`) is configured per-call rather than per-agent-definition. This is fine — goblin's config is already per-call.

### D6: Skill loading becomes filesystem-only

**Chosen:** Read `SKILL.md` files from `$GOBLIN_HOME/skills/` (and optionally `~/.agents/skills/`) and append content to the system prompt. No resource loader framework.

**Why not:** Pi's `DefaultResourceLoader` was doing this plus AGENTS.md discovery, context file loading, etc. Goblin already builds its own system prompt. The resource loader was an unnecessary intermediary.

**Constraints:** Skill file format stays the same (SKILL.md with frontmatter). AGENTS.md loading is already handled by `buildGoblinSystemPrompt()`.

### D7: pi-host.ts deleted, paths move to src/paths.ts

**Chosen:** Path helpers (`workdirPath`, `agentsMdPath`, etc.) move to a new `src/paths.ts`. `pi-host.ts` is deleted entirely.

**Why not:** Pi-host existed to construct pi service objects. With pi gone, only the path helpers remain. They don't deserve their own module named after a deleted dependency.

**Constraints:** All importers of `workdirPath`, `piAgentDir`, `agentsMdPath`, `soulMdPath` update to import from `src/paths.ts`.

## File Changes

### Created

| Path | Purpose |
|---|---|
| `src/paths.ts` | Path helpers extracted from `pi-host.ts` (`workdirPath`, `agentsMdPath`, `soulMdPath`). `piAgentDir` is removed (was only used for pi service paths). |

### Modified

| Path | Changes |
|---|---|
| `src/agent/mod.ts` | Replace pi's `AgentSession` with AI SDK's `streamText()`. Own `ModelMessage[]` array. Replace `init()` to construct provider instead of pi services. Replace `prompt()` to call `streamText()` and iterate `fullStream`. Replace `abort()` to use `AbortController`. Replace `compact()` to use `generateText()` for summarization. Add follow-up queue for in-flight messages. (~400 lines → ~300 lines, simpler) |
| `src/agent/events.ts` | Replace `dispatchAgentEvent(event: AgentSessionEvent, ...)` with `dispatchStreamEvent(part: StreamPart, ...)`. Replace pi event types with AI SDK stream part types. Keep `TurnCallbacks` interface unchanged. Keep `appendTranscriptEntry` adapted for AI SDK step results. Keep `TranscriptEntry` type unchanged. |
| `src/agent/models.ts` | Replace pi-ai imports (`Model`, `Api`, `getModel`, `getProviders`, etc.) with AI SDK provider constructors. Replace `ModelEntry.model: Model<Api>` with `ModelEntry` containing provider constructor + model ID. Replace `resolveModel()` to return `{ model: LanguageModel, apiKey, thinkingLevel }`. Remove `resolveMaxTokens()` and `resolveThinkingLevelMap()` — hardcoded in model entries. Add `clampThinkingLevel()` (was imported from pi-ai). |
| `src/agent/system-prompt.ts` | No change to prompt content. Skill loading changes from `DefaultResourceLoader.getSkills()` to direct filesystem reads from `$GOBLIN_HOME/skills/`. |
| `src/memory/tool.ts` | Replace pi's `defineTool()` with AI SDK's `tool()`. Replace typebox schemas with zod schemas. Function signatures change from `(toolCallId, params)` to `(params, options)`. Tool behavior unchanged. |
| `src/memory/tool.test.ts` | Update test mocks for new tool definition format. |
| `src/tg/tools.ts` | Replace pi's `defineTool()` with AI SDK's `tool()`. Replace typebox schemas with zod schemas. Return type changes from `ToolDefinition` to AI SDK's `Tool`. |
| `src/subagents/runner.ts` | Remove pi service imports. Remove `PiServices` and `getPiServices()`. Import `resolveModel` which now returns an AI SDK `LanguageModel` directly. Replace `SessionManager.create()` / `SessionManager.open()` with goblin's own `messages.jsonl` read/write. |
| `src/subagents/execution.ts` | Replace `createAgentSession()` with AI SDK's `generateText()` / `streamText()`. Remove pi event subscription. Use AI SDK step results + `fullStream` for event dispatch. Replace `ToolDefinition` with AI SDK `Tool`. |
| `src/subagents/tool.ts` | Replace pi's `defineTool()` with AI SDK's `tool()`. Replace typebox schemas with zod schemas. |
| `src/subagents/named-agents.ts` | Remove `DefaultResourceLoader` import. Replace with direct filesystem reads for skill loading (read `AGENTS.md`, scan `skills/` directory). |
| `src/subagents/types.ts` | Replace `AgentSession` and `SessionManager` type references with goblin's own types (`ModelMessage[]`, abort controller). |
| `src/bot.ts` | Replace `ToolDefinition` import with AI SDK `Tool` type. Replace `TextContent`/`ImageContent` from pi-ai with AI SDK's `CoreMessage` types. Replace `getSupportedThinkingLevels` / `clampThinkingLevel` imports with goblin's own. Remove `ThinkingLevel` from pi-agent-core, use goblin's own type. |
| `src/commands/model.ts` | Replace pi-agent-core `ThinkingLevel` type and pi-ai `clampThinkingLevel` with goblin's own. |
| `src/commands/think.ts` | Replace pi-agent-core `ThinkingLevel` type with goblin's own. |
| `src/commands/think.test.ts` | Replace pi-agent-core `ThinkingLevel` type with goblin's own. |
| `src/pi-host.ts` | **Deleted.** Path helpers move to `src/paths.ts`. Pi service construction removed. |
| `package.json` | Remove `@earendil-works/pi-coding-agent`. Add `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`. Remove `@sinclair/typebox` if no other consumer. |

### Deleted

| Path | Reason |
|---|---|
| `src/pi-host.ts` | Pi service construction removed. Path helpers moved. |

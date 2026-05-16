## Phase 1: Foundation — types, paths, and model registry

Set up AI SDK dependencies, create goblin-owned types, and rewrite the model registry. This phase leaves pi still in use but establishes all the new foundations that later phases depend on.

- [ ] `bun add @ai-sdk/openai @ai-sdk/anthropic zod` (ai already installed)
- [ ] Create `src/types.ts` — define goblin-owned `ThinkingLevel` type (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`), `ThinkingLevelMap` type, `clampThinkingLevel()` function (logic copied from pi-ai)
- [ ] Create `src/paths.ts` — extract `workdirPath`, `agentsMdPath`, `soulMdPath` from `pi-host.ts`. Do NOT move `piAgentDir` (only used by pi services, will be deleted)
- [ ] Rewrite `src/agent/models.ts` — replace pi-ai imports with AI SDK provider constructors. Replace `Model<Api>` with goblin's own `ModelEntry` containing `{ provider: () => LanguageModel, apiKeyEnv, thinkingLevel?, maxTokens }`. Replace `resolveModel()` to return `{ model: LanguageModel, apiKey, thinkingLevel }`. Hardcode `maxTokens` and `thinkingLevelMap` per model family. Remove `resolveMaxTokens()`, `resolveThinkingLevelMap()`, all pi-ai model database queries. Keep `MODELS` map, keep pattern-match functions (`poePatternMatch`, etc.) adapted for AI SDK providers
- [ ] Update `src/commands/model.ts` — import `ThinkingLevel`, `clampThinkingLevel`, `getSupportedThinkingLevels` from `src/types.ts` instead of pi-ai/pi-agent-core
- [ ] Update `src/commands/think.ts` and `src/commands/think.test.ts` — import `ThinkingLevel` from `src/types.ts` instead of pi-agent-core
- [ ] Verify: `bun run typecheck` passes (pi imports still exist elsewhere but these files are clean)

## Phase 2: Tool definitions — typebox → zod

Convert all tool definitions from pi's `defineTool()` + typebox to AI SDK's `tool()` + zod. This is a mechanical transformation.

- [ ] Rewrite `src/memory/tool.ts` — replace `defineTool` with `tool` from `ai`. Replace typebox `Type.Object(...)` schemas with `z.object(...)`. Update `execute` signatures from `(_toolCallId, params)` to `(params, options)`. Keep tool names, descriptions, and behavior identical
- [ ] Rewrite `src/memory/tool.test.ts` — update test mocks for new tool format
- [ ] Rewrite `src/tg/tools.ts` — replace `defineTool` with `tool` from `ai`. Replace typebox schemas with zod. Update `execute` signatures. Return AI SDK `Tool` type instead of pi's `ToolDefinition`
- [ ] Rewrite `src/subagents/tool.ts` — replace `defineTool` with `tool` from `ai`. Replace typebox schemas with zod. Update `execute` signatures
- [ ] Verify: `bun run typecheck` passes (tools are standalone, no runtime dependency on pi yet)

## Phase 3: Event system — pi events → AI SDK stream parts

Replace the event dispatch layer to work with AI SDK's `StreamPart` instead of pi's `AgentSessionEvent`.

- [ ] Rewrite `src/agent/events.ts` — rename `dispatchAgentEvent` to `dispatchStreamEvent`. Replace `AgentSessionEvent` parameter type with AI SDK's `StreamPart`. Map stream part types to `TurnCallbacks`: `text-delta` → `onTextDelta`, `tool-call` → `onToolStart`, `tool-result`/`tool-error` → `onToolEnd`, `reasoning-start`/`reasoning-delta` → `onStatusUpdate("thinking...")`, `finish` → `onAgentEnd`. Keep `TurnCallbacks` interface unchanged. Keep `appendTranscriptEntry` adapted for AI SDK step finish data (model, usage, stopReason). Keep `TranscriptEntry` type and JSONL format unchanged
- [ ] Verify: `bun run typecheck` passes

## Phase 4: AgentRunner — pi AgentSession → AI SDK streamText

The core replacement. Rewrite `AgentRunner` to use AI SDK directly.

- [ ] Rewrite `src/agent/mod.ts`:
  - Remove all pi imports (`AgentSession`, `SessionManager`, `createAgentSession`, `DefaultResourceLoader`)
  - Add AI SDK imports (`streamText`, `generateText`, `type LanguageModel`, `type ModelMessage`)
  - Replace `session: AgentSession | null` with `messages: ModelMessage[]` (conversation history)
  - Replace `init()` — construct `LanguageModel` from `resolveModel()`, build system prompt, load skills from filesystem. No pi services
  - Replace `prompt()` — assemble messages array (memory snapshot + user message + history), call `streamText({ model, messages, tools, maxSteps, abortSignal })`, iterate `fullStream`, dispatch via `dispatchStreamEvent()`. On completion, append `result.response.messages` to `messages[]`
  - Replace `abort()` — use `AbortController.abort()`
  - Replace `compact()` — call `generateText()` with summarization prompt, replace `messages[]` with summary
  - Add follow-up queue — array of pending messages, drained after each turn completes
  - Replace `isStreaming` — derived from whether `streamText()` promise is pending
  - Remove `subscribe()`/`unsubscribe()` pattern
  - Remove `sendCustomMessage()` / `followUp()` calls to pi's session
  - Remove `setThinkingLevel()` passthrough to pi — use `providerOptions` per-call
- [ ] Update `src/agent/system-prompt.ts` — replace `DefaultResourceLoader.getSkills()` with direct filesystem scan of `$GOBLIN_HOME/skills/`. Read SKILL.md files, parse frontmatter, append to system prompt
- [ ] Verify: `bun run typecheck` passes. Manual smoke test: goblin can respond to a basic prompt

## Phase 5: Subagents — pi AgentSession → AI SDK generateText

Rewrite the subagent execution engine to use AI SDK instead of pi.

- [ ] Rewrite `src/subagents/types.ts` — remove `AgentSession` and `SessionManager` references. Add `messages: ModelMessage[]` to `SubagentInstance`. Add `abortController: AbortController`
- [ ] Rewrite `src/subagents/execution.ts`:
  - Remove `createAgentSession` import
  - Add `generateText` from `ai`
  - Replace `_runInstanceInner()` — construct `LanguageModel`, build tool set, call `generateText({ model, messages, tools, maxSteps, abortSignal })`. Iterate `steps` to dispatch events via `dispatchStreamEvent` adapter. Accumulate text. Persist messages to `messages.jsonl`
  - Remove `session.subscribe()` pattern
  - Replace teardown — null out `abortController` instead of calling `session.dispose()`
- [ ] Rewrite `src/subagents/runner.ts`:
  - Remove pi imports (`SessionManager`, `ToolDefinition`)
  - Remove `PiServices`, `getPiServices()`, `createPiServices()` usage
  - Replace `SessionManager.create()` / `SessionManager.open()` with goblin's own `messages.jsonl` read/write
  - Import `Tool` from `ai` instead of `ToolDefinition` from pi
- [ ] Rewrite `src/subagents/named-agents.ts`:
  - Remove `DefaultResourceLoader`, `ResourceLoader`, `SettingsManager` imports
  - Replace `buildResourceLoader()` with `loadSkillsForAgent()` — read `AGENTS.md` from named agent dir, scan `skills/` directory for SKILL.md files, return system prompt + skill content
- [ ] Update `src/subagents/mod.ts` — update exports for new types
- [ ] Verify: `bun run typecheck` passes. Smoke test: spawn a subagent and get a result

## Phase 6: Wiring — bot.ts, commands, and cleanup

Update the remaining consumers and remove pi entirely.

- [ ] Update `src/bot.ts` — replace `ToolDefinition` with AI SDK `Tool`. Replace `TextContent`/`ImageContent` from pi-ai with AI SDK `CoreMessage` content types. Replace `getSupportedThinkingLevels` from pi-ai with goblin's own. Remove `ThinkingLevel` from pi-agent-core
- [ ] Delete `src/pi-host.ts` — all importers updated in previous phases
- [ ] Update `src/subagents/test/support.ts` and `src/subagents/test/guards.suite.ts` — replace pi type references
- [ ] Update `src/agent/mod.test.ts` — replace pi type references (`ImageContent`, `TextContent`) with AI SDK equivalents
- [ ] Remove `@earendil-works/pi-coding-agent` from `package.json` via `bun remove @earendil-works/pi-coding-agent`
- [ ] Remove `@sinclair/typebox` if no remaining consumers: `bun remove @sinclair/typebox`
- [ ] Verify: `bun install` succeeds, `bun run typecheck` passes, no remaining pi imports in `src/`
- [ ] Run full test suite: `bun test`
- [ ] Manual integration test: start goblin, send a message, verify streaming response, test abort, test subagent spawn, test memory read/write, test compact

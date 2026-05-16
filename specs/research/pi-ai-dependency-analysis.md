# pi-ai Dependency Analysis

**Date:** 2025-05-15  
**Status:** Research findings  

---

## Context

Goblin uses three pi packages as its AI infrastructure:

| Package | Role |
|---|---|
| `@earendil-works/pi-coding-agent` | Session management, resource loading, tool registration, compaction |
| `@earendil-works/pi-ai` | Provider streaming, HTTP clients, model registry, content types |
| `@earendil-works/pi-agent-core` | Agent loop, tool dispatch, event system |

Only `pi-coding-agent` is declared in `package.json`. The other two are transitive dependencies reachable through hoisted `node_modules`.

Goblin imports from all three directly.

---

## Motivation

Two capabilities goblin needs that pi-ai does not support:

1. **Native file attachments** — sending PDFs, documents, and other files directly in model context so the model can reason with them. Currently goblin saves files to disk and tells the model the path; the model must use bash/read tools to extract text content.

2. **Provider-native tools** — e.g. OpenAI's `web_search` tool for GPT-5 series models. Provider tools are invoked server-side during generation, not via client-side tool dispatch. pi-ai has no mechanism to pass them through.

---

## Architecture: How the Pieces Connect

### Call chain for every LLM request

```
goblin (AgentRunner.prompt)
  → pi-coding-agent (AgentSession.sendUserMessage)
    → pi-agent-core (Agent.prompt → Agent.runPromptMessages → agent loop)
      → pi-agent-core constructs Context { systemPrompt, messages, tools }
      → pi-agent-core calls streamFn(model, context, options)
        → pi-coding-agent's streamFn wrapper (auth, headers, retries)
          → pi-ai streamSimple(model, context, options)
            → pi-ai provider (e.g. streamOpenAIResponses)
              → builds HTTP params from Context
              → calls OpenAI / Anthropic / etc SDK
              → returns AssistantMessageEventStream
      → pi-agent-core processes stream events
      → if tool calls: execute tools, append results, loop back to streamFn
      → if stop: emit agent_end
```

### Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Content type definitions | pi-ai | `TextContent`, `ImageContent`, `ThinkingContent`, `ToolCall` |
| User message shape | pi-ai | `UserMessage.content: string \| (TextContent \| ImageContent)[]` |
| Context shape | pi-ai | `Context { systemPrompt, messages, tools?: Tool[] }` |
| Tool definition | pi-ai | `Tool { name, description, parameters }` — pi's own schema |
| Agent loop | pi-agent-core | Prompt → stream → process events → tool dispatch → loop |
| `Agent.prompt()` signature | pi-agent-core | `prompt(input: string, images?: ImageContent[])` |
| `convertToLlm` | pi-coding-agent | Converts AgentMessage[] → pi-ai Message[] |
| `streamFn` construction | pi-coding-agent | Hardcodes `streamSimple` from pi-ai |
| Provider serialization | pi-ai | Converts pi-ai types → provider-specific wire format |
| Session persistence | pi-coding-agent | JSONL session files, resume, compaction |
| Resource loading | pi-coding-agent | AGENTS.md, skills, context files |

---

## Finding 1: The Content Type Union Is Closed

pi-ai defines user content as:

```typescript
// pi-ai types.d.ts
interface TextContent  { type: "text";  text: string }
interface ImageContent { type: "image"; data: string; mimeType: string }

interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

There is no `FileContent` variant. No `DocumentContent`. No generic `BinaryContent`. The union is `TextContent | ImageContent` and nothing else.

This closed union propagates through every layer:

1. **pi-agent-core** — `Agent.prompt(input: string, images?: ImageContent[])` — only accepts text + images
2. **pi-coding-agent** — `convertToLlm()` maps custom messages to `(TextContent | ImageContent)[]`
3. **pi-ai** — provider serializers only handle `text` → `input_text` and `image` → `input_image`

Adding a new content type would require coordinated changes across all three packages.

### What OpenAI's Responses API actually supports

The OpenAI Responses API accepts these input content types:

- `input_text` — text content
- `input_image` — image content (URL or base64)
- `input_file` — file attachment (PDF, etc.) with `file_data` (base64) or `file_url`, plus optional `filename`

pi-ai serializes to the first two only. The third is unreachable.

---

## Finding 2: Provider-Native Tools Are Not Pass-Through

pi-ai's `Context.tools` uses pi's own tool abstraction:

```typescript
// pi-ai types.d.ts
interface Tool<TParameters> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

These get serialized by the provider layer. For OpenAI Responses API:

```javascript
// pi-ai openai-responses-shared.js
export function convertResponsesTools(tools, options) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
```

Every tool is wrapped as `type: "function"`. There is no mechanism to pass through provider-native tool types like:

```json
{ "type": "web_search", "search_context_size": "medium" }
{ "type": "code_interpreter", "container": { ... } }
```

The OpenAI Responses API `tools` array accepts both `function` tools and native tool types. pi-ai can only produce the former.

---

## Finding 3: `onPayload` Is a Partial Escape Hatch

pi-ai's OpenAI Responses provider has a hook:

```javascript
// pi-ai openai-responses.js, inside streamOpenAIResponses
let params = buildParams(model, context, options);
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) {
  params = nextParams;
}
```

`onPayload` receives the fully-serialized OpenAI API params object and can mutate or replace it. This is used by pi-coding-agent's extension system (`before_provider_request` event).

### What `onPayload` could do

- **Inject `{ type: "web_search" }` into `params.tools`** — the model would invoke web search
- **Modify user message content** — replace `input_text` blocks with `input_file` blocks

### What `onPayload` cannot solve

**Web search (lossy):** The OpenAI API returns `web_search_call` output items (queries, page opens, sources) alongside the `message` item. pi-ai's stream processor (`processResponsesStream`) only handles three item types: `reasoning`, `message`, and `function_call`. Search metadata items are silently ignored. The model's text answer arrives, but citations, source URLs, and search queries are lost.

**File attachments (blocked upstream):** The content must pass through four serialization layers before reaching `onPayload`:

```
goblin constructs content  →  string | (TextContent | ImageContent)[]
     ↓
pi-agent-core Agent.prompt()  →  (input: string, images?: ImageContent[])
     ↓
pi-coding-agent convertToLlm()  →  Message { content: (TextContent | ImageContent)[] }
     ↓
pi-ai convertResponsesMessages()  →  { type: "input_text" } | { type: "input_image" }
     ↓
onPayload sees the params — already serialized
```

At layer 1, goblin literally cannot represent a file. The type union doesn't include it. At layer 2, `Agent.prompt()` only accepts string + images. Even encoding file data as a text block and rewriting it in `onPayload` would have no reliable way to distinguish "this text block is actually a file" from actual text.

---

## Finding 4: The Three Packages Are a Coupled Unit

The packages are separated for **code organization**, not **substitution**. Evidence:

1. **pi-coding-agent hardcodes pi-ai's streaming function.** In `sdk.js`:
   ```javascript
   import { streamSimple } from "@earendil-works/pi-ai";
   // ...
   streamFn: async (model, context, options) => {
     return streamSimple(model, context, { ... });
   }
   ```
   There is no option to override `streamFn` in `createAgentSession()`.

2. **pi-agent-core's types come from pi-ai.** The `Agent` class in pi-agent-core imports `ImageContent`, `Message`, `Tool`, `AssistantMessage`, `SimpleStreamOptions` from pi-ai. These are not abstract interfaces — they are concrete pi-ai types.

3. **pi-coding-agent's `convertToLlm` produces pi-ai `Message[]`.** Not an abstract message type — specifically `Message` from pi-ai's type union.

4. **pi-coding-agent's `AgentSession` calls pi-ai utilities.** `clampThinkingLevel`, `getSupportedThinkingLevels`, `isContextOverflow`, `cleanupSessionResources`, `modelsAreEqual` — all imported directly.

You cannot remove or replace pi-ai without also modifying pi-coding-agent and pi-agent-core. The type system and the streaming function bind all three together.

---

## Import Map: Where Goblin Touches Each Package

### `@earendil-works/pi-ai` (14 import sites)

| File | Import | Usage |
|---|---|---|
| `src/agent/models.ts` | `Api`, `Model`, `ThinkingLevelMap` | Type annotations for model registry |
| `src/agent/models.ts` | `getModel`, `getModels`, `getProviders` | Query pi-ai's built-in model database for maxTokens, thinkingLevelMap |
| `src/agent/mod.ts` | `TextContent`, `ImageContent` | Type annotations for multimodal content |
| `src/agent/mod.test.ts` | `TextContent`, `ImageContent` | Test mocks |
| `src/bot.ts` | `TextContent`, `ImageContent` | Constructing photo/caption content arrays |
| `src/bot.ts` | `getSupportedThinkingLevels` | UI display of available thinking levels |
| `src/commands/model.ts` | `clampThinkingLevel` | Clamping user-selected thinking level to model capabilities |

### `@earendil-works/pi-agent-core` (5 import sites)

| File | Import | Usage |
|---|---|---|
| `src/agent/mod.ts` | `ThinkingLevel` | Type annotation |
| `src/bot.ts` | `ThinkingLevel` | Type annotation |
| `src/commands/model.ts` | `ThinkingLevel` | Type annotation |
| `src/commands/think.ts` | `ThinkingLevel` | Type annotation |
| `src/commands/think.test.ts` | `ThinkingLevel` | Type annotation |

### `@earendil-works/pi-coding-agent` (18 import sites)

| File | Import | Usage |
|---|---|---|
| `src/pi-host.ts` | `AuthStorage`, `ModelRegistry`, `SettingsManager` | Infrastructure factories |
| `src/agent/mod.ts` | `AgentSession`, `DefaultResourceLoader`, `SessionManager`, `createAgentSession`, `ToolDefinition`, `AgentSessionEvent` | Core agent lifecycle |
| `src/agent/events.ts` | `AgentSessionEvent` | Event type dispatch |
| `src/tg/tools.ts` | `defineTool`, `ToolDefinition` | Telegram β-tools |
| `src/memory/tool.ts` | `defineTool`, `ToolDefinition` | Memory tools |
| `src/subagents/runner.ts` | `ToolDefinition`, `SessionManager` | Subagent lifecycle |
| `src/subagents/execution.ts` | `createAgentSession`, `AgentSessionEvent`, `ToolDefinition` | Subagent execution |
| `src/subagents/tool.ts` | `defineTool`, `ToolDefinition` | Spawn/revive tools |
| `src/subagents/named-agents.ts` | `DefaultResourceLoader`, `ResourceLoader`, `SettingsManager` | Named agent isolation |
| `src/subagents/types.ts` | `AgentSession`, `SessionManager` | Type annotations |
| `src/bot.ts` | `ToolDefinition` | Type annotation |

---

## What Goblin Uses From pi-ai's Model Database

`src/agent/models.ts` calls three pi-ai functions to enrich goblin's own model registry:

| Function | What goblin gets from it |
|---|---|
| `getProviders()` | List of all known providers (openai, anthropic, zai, etc.) |
| `getModel(provider, id)` | Full `Model<Api>` descriptor for a specific model |
| `getModels(provider)` | All models for a provider, used for prefix matching |

These are used to resolve two properties goblin doesn't want to hardcode:

1. **`maxTokens`** — maximum output tokens for a model family. Goblin falls back to 8,192 but queries pi-ai first with exact → stripped-date-suffix → longest-prefix matching.

2. **`thinkingLevelMap`** — maps pi thinking levels (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`) to provider-specific values (e.g. Anthropic `"enabled"` vs OpenAI `"medium"`). Used to clamp user-selected levels correctly per model family.

If pi-ai were removed, goblin would need its own database of `maxTokens` and `thinkingLevelMap` per model family. This is straightforward but requires maintenance as new models ship.

---

## Options Assessment

### Option A: `onPayload` hook (partial, fragile)

- **Web search:** Works for getting answers. Loses citations and source URLs. Fragile to OpenAI API changes.
- **File attachments:** Not possible. Content is serialized away before the hook fires.
- **Effort:** Small (use pi-coding-agent's extension system)
- **Risk:** High — depends on undocumented pi-ai internals, breaks if pi-ai changes serialization

### Option B: Replace pi-ai's streaming layer

Write goblin's own streaming functions that call provider SDKs directly, producing the same `AssistantMessageEventStream` shape. Inject via pi-agent-core's `streamFn` constructor option.

- **Requires:** Forking or patching pi-coding-agent to expose `streamFn` override in `createAgentSession()`
- **Gains:** Full control over serialization. Can add `FileContent`, native tools, anything.
- **Keeps:** pi-agent-core's agent loop, pi-coding-agent's session management, tool dispatch, compaction
- **Effort:** Medium-large (3+ provider serializers)
- **Risk:** Must keep goblin's serializers compatible with pi-agent-core's event protocol

### Option C: Upstream PR to pi mono repo

Add `FileContent` to the type union, add `nativeTools` passthrough to `Context`, update provider serializers.

- **Gains:** Cleanest solution. Benefits all pi users.
- **Requires:** Coordinated changes across three packages in the pi mono repo
- **Effort:** Medium (implementation) + unknown (review/merge timeline)
- **Risk:** Lowest technical risk, highest schedule risk

### Option D: Replace all three pi packages

Build goblin's own agent loop, streaming, and session management. Remove all pi dependencies.

- **Gains:** Complete control. No coupling to pi's release cycle.
- **Requires:** Reimplementing agent loop, tool dispatch, streaming, session persistence, compaction, resource loading
- **Effort:** Very large
- **Risk:** Goblin is a single-user homelab project. This is disproportionate.

---

## Summary

pi-ai is the narrowest package but sits at the center of a coupled type system. It cannot be removed in isolation because:

1. pi-agent-core's `Agent` imports concrete pi-ai types (`ImageContent`, `Message`, `Tool`)
2. pi-coding-agent hardcodes `streamSimple` as the streaming function
3. pi-coding-agent's `convertToLlm` produces pi-ai `Message[]`
4. The `onPayload` hook sees serialized data too late for file attachments
5. Provider-native tools get wrapped as `function` tools with no passthrough

The packages are layered for organization, not substitution. Any solution that changes one likely requires changes to the others.

# Beta Tools — Design

## Architecture

Beta tools live in `src/tg/tools.ts` (Telegram layer) and are instantiated per session in `src/bot.ts`, then passed to `AgentRunner` as `customTools`.

```
src/bot.ts (telegram layer)
  │
  ├── resolve session (chatId, topicId, messageId)
  │
  ├── create tools:
  │   createSendVoiceTool(bot, chatId)
  │   createSendPhotoTool(bot, chatId)
  │   createSendDocumentTool(bot, chatId)
  │   createReactTool(bot, chatId, messageId)
  │   createRenameTopicTool(bot, chatId, topicId) // null if no topic
  │   createChatActionTool(bot, chatId)
  │
  ├── filter(Boolean) to remove nulls (e.g., rename_topic in DMs)
  │
  └── pass tools[] to new AgentRunner(cfg, sessionId, tools)

src/agent/mod.ts (AgentRunner)
  │
  └── passes tools[] to pi's createAgentSession({ customTools: tools })
      (unchanged from agent-runner design)

@mariozechner/pi-coding-agent
  │
  └── registers tools in ToolRegistry
      exposes to LLM in system prompt
      invokes handler with validated args (no chatId param possible)
```

**Key invariant:** `src/agent/` never sees grammy types. It receives `ToolDefinition[]` as opaque objects. The closure captures `chatId`, making the tool self-contained.

## Decisions

### Tools are closures, not classes

**Chosen:** Each factory returns a plain `ToolDefinition` object with `name`, `description`, `parameters`, and `handler` that closes over `chatId`/`topicId`/`messageId`.

**Why:** Simple, serializable, matches pi's expected interface. No mutable state, no lifecycle management.

**Alternative rejected:** Class-based tools with `setContext()` methods. Would require mutable state and more boilerplate.

### Rename topic returns null in DMs, not a no-op tool

**Chosen:** `createRenameTopicTool(bot, chatId, undefined)` returns `null`.

**Why:** The caller (`bot.ts`) can `.filter(Boolean)` to remove it. A no-op tool would still appear in the LLM's tool list, which is confusing ("why can I rename topics in a DM?").

**Alternative rejected:** Returning a tool that throws or does nothing. Would pollute the LLM's context with useless tools.

### React tool requires messageId binding at creation

**Chosen:** `createReactTool(bot, chatId, messageId)` — the message to react to is fixed at tool creation. If `messageId` is undefined, returns `null`.

**Why:** Reactions typically target the message being replied to. The LLM can't specify a messageId without hallucination risk. The bot layer knows which message it's responding to. Some message types (channel posts, service messages) may not have `message_id`; we return null to skip the tool in those cases.

**Constraint:** If goblin wants to react to a different message, it needs a new tool instance (different `messageId`). This is acceptable — reactions are typically "respond to current turn."

### No interactive/callback tools in v1

**Deferred:** Inline keyboards, callback queries, conversation flows that require state machine.

**Why:** Complex UX patterns need design (who owns the callback handler? how does state persist across turns?). v1 focuses on simple fire-and-forget actions.

### Error handling: return structured result, not throw

**Chosen:** Tool handlers catch Telegram API errors and return `{ok: false, error: string}`. On success, return `{ok: true, ...}`.

**Why:** Gives the LLM visibility into what happened. Pi's tool system handles thrown errors too, but returning structured data is cleaner for "user blocked bot" or "file not found" cases.

### No rate limiting or retry logic in tools

**Chosen:** Tools call Telegram API directly with no debounce, rate limiting, or retry.

**Why:** Rate limiting is a cross-cutting concern that belongs in the Telegram layer (MessageBuffer has throttling for edits; bot-level concerns handle API flood protection). Each tool shouldn't implement its own backoff.

**Risk:** A misbehaving LLM could spam `send_voice` 100x/second. Acceptable for v1 (YOLO mode) — fix with rate limiting at the tool-call layer in v1.1.

## File Changes

### New files

- **`src/tg/tools.ts`** — Exports all β tool factory functions.
  - Imports: `grammy` (`Bot`, `InputFile`), `@mariozechner/pi-coding-agent` (`ToolDefinition`).
  - Exports: `createSendVoiceTool`, `createSendPhotoTool`, `createSendDocumentTool`, `createReactTool`, `createRenameTopicTool`, `createChatActionTool`.
  - Covers: all factory requirements, closure binding, parameter validation, Telegram API calls, error handling.

- **`src/tg/tools.test.ts`** — Unit tests for factories and handlers.
  - Mock grammy's `bot.api` methods.
  - Assert schemas don't contain `chatId`, `topicId`, `messageId`.
  - Assert handlers call mocked API with correct bound context.
  - Assert validation errors return structured results.

### Modified files

- **`src/bot.ts`** — Per-session tool instantiation.
  - After session resolution and before `AgentRunner` creation, call all tool factories with `ctx.chat.id`, `ctx.message?.message_thread_id`, `ctx.message?.message_id`.
  - Filter out `null` values (e.g., `rename_topic` in DMs).
  - Pass the resulting array to `new AgentRunner(...)`.
  - Covers: "Bot.ts instantiates tools per session" requirement.

- **`src/agent/mod.ts`** — (Minor) Verify `customTools` parameter exists and is passed through (already done in `agent-runner`, just ensure no regression).

### Not touched

- `src/sessions/` — no changes; sessions provide `sessionId` only, not tool context.
- `src/commands/` — no new commands in this scope.
- `src/config.ts` — no new env vars.

## Type signatures

```typescript
// src/tg/tools.ts
import type { Bot } from "grammy";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function createSendVoiceTool(
  bot: Bot,
  chatId: number
): ToolDefinition;

export function createSendPhotoTool(
  bot: Bot,
  chatId: number
): ToolDefinition;

export function createSendDocumentTool(
  bot: Bot,
  chatId: number
): ToolDefinition;

export function createReactTool(
  bot: Bot,
  chatId: number,
  messageId: number
): ToolDefinition;

export function createRenameTopicTool(
  bot: Bot,
  chatId: number,
  topicId?: number
): ToolDefinition | null;

export function createChatActionTool(
  bot: Bot,
  chatId: number
): ToolDefinition;
```

## Tool schemas (LLM-facing)

| Tool | Parameters |
|------|-----------|
| `send_voice` | `{voiceFile: string, caption?: string}` |
| `send_photo` | `{photoFile: string, caption?: string}` |
| `send_document` | `{documentFile: string, caption?: string}` |
| `react` | `{emoji: string}` (single emoji char) |
| `rename_topic` | `{title: string}` |
| `chat_action` | `{action: "typing" | "upload_photo" | "record_voice" | "upload_document"}` |

All `chatId`, `messageId`, `topicId` are closed over and invisible to LLM.

# Beta Tools (β Tools)

## Motivation

Goblin has "deep use of Telegram as its UI" (`progress.md:16`). This means more than receiving messages — goblin can send voice notes, react with emojis, rename forum topics, send files, pin messages, and use inline keyboards. These are Telegram-native affordances (β tools) that the LLM should be able to use.

However, β tools are **session-bound** — a `send_voice` tool must know which `chatId` to send to. The LLM cannot be trusted to pass `chatId` as a parameter (hallucination risk). The tool must be instantiated with `chatId` baked into its closure, so the LLM only sees business args (`voiceFile`, `caption`).

This change provides the factory functions for creating these tools and wires them into `AgentRunner`.

## Scope

### In scope
- `src/tg/tools.ts` exporting factory functions for Telegram-native tools:
  - `createSendVoiceTool(bot, chatId)` — send voice messages
  - `createSendPhotoTool(bot, chatId)` — send images
  - `createSendDocumentTool(bot, chatId)` — send arbitrary files
  - `createReactTool(bot, chatId, messageId)` — add emoji reactions
  - `createRenameTopicTool(bot, chatId, topicId)` — rename forum topics (returns `null` if `topicId` is undefined for DMs)
  - `createChatActionTool(bot, chatId)` — set "typing..." status
- Each factory returns a `ToolDefinition` with `chatId`/`topicId`/`messageId` closed over in the handler.
- No `chatId`/`messageId`/`topicId` parameters exposed in any tool schema.
- `src/bot.ts` updated to instantiate tools per session and pass them to `AgentRunner`.
- Tool handler implementations use grammy's `bot.api` methods.

### Out of scope
- Subagent orchestration tools (γ tools: `spawn_subagent`, `revive_subagent`). Separate change.
- Interactive keyboards, inline queries, or callback handlers. Complex UX patterns deferred to v1.x.
- Voice message generation (text-to-speech). β tools only handle sending; the LLM can use a separate skill or external service to create the audio file.

## Non-Goals

- **No generic tool wrappers.** Each β tool is explicitly implemented and typed, not dynamically constructed from a schema.
- **No stateful tool instances.** Tools are pure closures over their bound context; no mutable state per tool.
- **No error recovery on Telegram API failures.** Tools throw or return `{ok: false, error}` on failure; the LLM handles it.
- **No rate limiting in tools.** Rate limiting is the Telegram layer's concern (MessageBuffer or bot.ts), not individual tool handlers.

# Tasks: multimodal-native-pdf

## Phase 1: pi-ai and pi-coding-agent patches for DocumentContent

- [ ] Apply `bun patch @mariozechner/pi-ai` to unlock the package for editing
- [ ] Add `DocumentContent` interface and widen `UserMessage.content`, `ToolResultMessage.content`, `Model.input` in `dist/types.d.ts`
- [ ] Add `document` block handling in Anthropic provider `dist/providers/anthropic.js` (user message encoding + beta header injection when documents present)
- [ ] Add `input_file` handling in OpenAI Responses `dist/providers/openai-responses-shared.js` (content mapping + filter by model input capability)
- [ ] Apply `bun patch @mariozechner/pi-coding-agent` to unlock the package for editing
- [ ] Widen `sendUserMessage`, `followUp`, `steer`, `PromptOptions.images` signatures in `dist/core/agent-session.d.ts` to accept `DocumentContent` alongside `ImageContent`
- [ ] Save patches with `bun patch --save` for both packages, verify patches are committed to `patches/`
- [ ] Verify: `bun run src/index.ts` compiles and existing tests pass with patches applied

## Phase 2: Agent content part construction and model config

- [ ] Create `src/agent/files.ts` with `FileAttachment` interface export and `resolveContentParts(files: FileAttachment[]): (TextContent | ImageContent | DocumentContent)[]` — MIME-based dispatch (`image/*` → `ImageContent`, `application/pdf` → `DocumentContent`, else → `DocumentContent`)
- [ ] Widen `AgentRunner.prompt()` in `src/agent/mod.ts`: add optional `files?: FileAttachment[]` parameter. When files present, construct content parts via `resolveContentParts()`, prepend text content part (or use "What do you see in this image?" default if text is empty), call `session.sendUserMessage(contentParts)` (non-streaming) or `session.sendUserMessage(contentParts, { deliverAs: "followUp" })` (streaming). When files absent, call existing `session.sendUserMessage(text)` as before.
- [ ] Re-export `FileAttachment` type from `src/agent/mod.ts`
- [ ] Update `src/agent/models.ts`: add `"document"` to `input` arrays for Anthropic direct models (`anthropic/claude-opus-4`, `anthropic/claude-sonnet-4.6`) and OpenAI Responses models (`openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/o4`)
- [ ] Unit-test `resolveContentParts()` for JPEG, PNG, PDF, unknown MIME types
- [ ] Unit-test `AgentRunner.prompt()` with files: text+image, text+pdf, image-only (default text), streaming followUp with files

## Phase 3: Telegram file receivers

- [ ] Create `src/tg/download.ts` with `downloadFile(bot: Bot, fileId: string): Promise<{ buffer: Buffer, mimeType: string, filename?: string }>`. Calls `bot.api.getFile(fileId)`, fetches from `https://api.telegram.org/file/bot<token>/<file_path>` using `fetch()`, returns buffer + MIME (from Telegram's `file_path` extension or `mime_type` field). Throws on network failure with descriptive error.
- [ ] Add `bot.on("message:document", ...)` handler in `src/bot.ts` after the `message:text` handler. Resolves session/runner, downloads file via `downloadFile()`, base64-encodes buffer, constructs `FileAttachment`, calls `runner.prompt(caption, buffer, [file])`. Uses `ctx.msg?.caption || ""` for text. Follows same session/resolution logic as `message:text` (the existing code from `const locator = locatorFromCtx(ctx)` through `try { await runner.prompt(text, buffer); }` — extract into a shared dispatch helper or duplicate inline).
- [ ] Add `bot.on("message:photo", ...)` handler in `src/bot.ts`. Selects the last (largest) `ctx.msg?.photo[]` entry, downloads, constructs `ImageContent` via `FileAttachment` with `mimeType: "image/jpeg"`. Routes to agent same as document handler.
- [ ] Error handling: on download failure, reply to user with error message. On no session, reply with `/new` prompt for DMs, silently drop for topics (mirror existing text behavior).
- [ ] Smoke test: send a photo and a PDF to goblin in Telegram, verify the LLM sees and describes the content correctly

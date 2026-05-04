# Design: multimodal-native-pdf

## Architecture

The change adds a side path for file messages that runs parallel to the existing text message pipeline, converging at `AgentRunner.prompt()`. No existing code paths are modified — text-only messages follow the exact same flow as before.

```
bot.on("message:document")  ─┐
bot.on("message:photo")    ─┼─→ downloadFile() → FileAttachment
bot.on("message:text")     ─┘    (existing, unchanged for text)
                                      │
                                      ▼
                              AgentRunner.prompt(text, callbacks, files?)  ← widened
                                      │
                                      ▼
                              construct content parts
                              [{ type: "text", ... }, { type: "document"|"image", ... }]
                                      │
                                      ▼
                              session.sendUserMessage(contentParts)  ← existing API, widened via patch
                                      │
                                      ▼
                              pi-ai provider encodes to native API format
```

**Key principle**: File download and content part construction happen in the **Telegram layer** (bot handlers), not in the agent layer. The agent layer is widened to accept pre-constructed `FileAttachment` objects but doesn't know about Telegram. This preserves the existing boundary: `src/agent/` never imports grammy.

### Component relationships

| Component | Location | Role |
|---|---|---|
| `downloadFile()` (new) | `src/tg/download.ts` | Fetches file bytes from Telegram via `getFile()`, returns `Buffer` + metadata |
| File handlers (new) | `src/bot.ts` | `message:document` and `message:photo` listeners that download, construct `FileAttachment`, route to agent |
| `FileAttachment` type (new) | `src/agent/mod.ts` | Type exported for Telegram→Agent boundary: `{ data: string, mimeType: string, filename?: string }` |
| `AgentRunner.prompt()` (modified) | `src/agent/mod.ts` | Accepts optional `files?: FileAttachment[]`, constructs content parts |
| `resolveContentParts()` (new) | `src/agent/files.ts` | Converts `FileAttachment[]` to `(TextContent \| ImageContent \| DocumentContent)[]` based on MIME type |
| pi-ai patches (new) | `patches/@mariozechner/pi-ai/*.patch` | `DocumentContent` type, Anthropic + Responses provider encoding |
| pi-coding-agent patches (new) | `patches/@mariozechner/pi-coding-agent/*.patch` | Widened `sendUserMessage`, `followUp`, `steer` signatures |
| Model configs (modified) | `src/agent/models.ts` | Add `"document"` to `input` for Anthropic direct and OpenAI Responses entries |

## Decisions

### 1. Files arrive via separate `files[]` parameter, not merged into text

**Chosen**: `AgentRunner.prompt(text: string, callbacks: TurnCallbacks, files?: FileAttachment[])`.

**Why**: Separating text and files keeps the existing prompt() signature backward-compatible. Every call site passes `ctx.msg?.text` for text — that doesn't change. Files are an additional, optional channel. Merging into a single content array at the prompt() level would force every call site to construct the array.

**Constraint**: The AgentRunner is responsible for merging text and files into a single content parts array before calling the session API. This means the runner knows about content part types but doesn't know about file origins.

### 2. MIME-based content part dispatch in `src/agent/files.ts`

**Chosen**: A standalone pure function `resolveContentParts(files: FileAttachment[]): (TextContent | ImageContent | DocumentContent)[]` that dispatches by MIME prefix.

**Why**: Centralized, testable in isolation, no dependency on Telegram or pi internals. The mapping is simple and unlikely to change:
- `image/*` → `ImageContent`
- `application/pdf` → `DocumentContent`
- Everything else → `DocumentContent` (model filters by capability)

**Constraint**: Providers may not support all MIME types in document blocks. The provider-level filtering (already exists for images via `model.input.includes("image")`) handles this. We extend that pattern to `"document"`.

### 3. File download is fire-and-forget within the handler

**Chosen**: The bot handler downloads the file, constructs the `FileAttachment`, and calls `runner.prompt()`. No streaming download, no progress reporting to the user. On failure, a text-only fallback is sent to the agent.

**Why**: Telegram files are at most 20MB. Downloads complete in seconds on a local connection. Streaming adds complexity (signal handling, partial reads, abort integration) without meaningful user benefit for this file size range. The agent sees the download result, not the download progress.

**Constraint**: A 20MB file will block the event loop for the duration of the HTTP download. This is acceptable for a single-user bot — goblin doesn't multiplex multiple simultaneous file downloads.

### 4. `bun patch` for pi-mono changes

**Chosen**: Apply type and provider changes to `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` via `bun patch`, committing the patch files.

**Why**: Zero fork maintenance. Zero upstream timeline dependency. Patches auto-apply on `bun install`. Breaks on version bumps with visible errors (no silent degradation).

**Alternatives**:
- Fork: permanent maintenance burden for a small set of changes
- Upstream PR: blocked on review/merge/release cycle; suitable as follow-on

**Constraint**: Patches are applied to compiled `.js` and `.d.ts` files in `dist/`, not to TypeScript source. The patch format (unified diff) is sensitive to line number shifts. On pi-mono version bumps, patches must be regenerated.

### 5. No Photo→ImageContent conversion delay

**Chosen**: Telegram photos are downloaded and base64-encoded inline in the handler, then passed as `ImageContent`. No external image processing.

**Why**: pi-ai already handles `ImageContent` end-to-end for Anthropic and Responses providers. The LLM receives the raw image bytes. No need for a separate vision model or description step.

**Constraint**: Photos from Telegram are JPEG. HEIC is not supported by Telegram's bot API (bots receive JPEG regardless of what the user sent).

## File Changes

### New files

| Path | Purpose |
|---|---|
| `src/tg/download.ts` | `downloadFile(bot: Bot, fileId: string): Promise<{ buffer: Buffer, mimeType: string, filename?: string }>` — Calls `bot.api.getFile(fileId)`, fetches from `https://api.telegram.org/file/bot<token>/<path>`, returns buffer. On failure, throws with descriptive error. |
| `src/agent/files.ts` | `FileAttachment` interface export. `resolveContentParts(files: FileAttachment[]): (TextContent \| ImageContent \| DocumentContent)[]` — MIME-based dispatch to content part types. Pure function, no I/O. |

### Modified files

| Path | Changes |
|---|---|
| `src/bot.ts` | Add `bot.on("message:document", ...)` and `bot.on("message:photo", ...)` handlers after the `message:text` handler. Each: resolves session/runner, downloads file via `downloadFile()`, constructs `FileAttachment`, calls `runner.prompt(caption, buffer, [file])`. Text extraction from `ctx.msg?.caption` for documents, `ctx.msg?.caption` for photos. |
| `src/agent/mod.ts` | Widen `prompt(text, callbacks, files?)` signature. In method body: if `files` is present and non-empty, construct content parts via `resolveContentParts(files)`, prepend text content part, call `session.sendUserMessage(contentParts)` or `session.followUp(text, documentParts)`. For backward compat, if `files` is absent, call `session.sendUserMessage(text)` as before. Re-export `FileAttachment` type. |
| `src/agent/models.ts` | Update `input` arrays for Anthropic direct models and OpenAI Responses models to include `"document"`. |
| `package.json` | No changes (patches are stored in `patches/` directory managed by `bun patch`). |

### Patches (new, in `patches/`)

| Patch file | Covers | Changes |
|---|---|---|
| `@mariozechner+pi-ai+<version>.patch` | `dist/types.d.ts`, `dist/providers/anthropic.js`, `dist/providers/openai-responses-shared.js` | `DocumentContent` type, Anthropic document encoding + beta header, Responses `input_file` encoding |
| `@mariozechner+pi-coding-agent+<version>.patch` | `dist/core/agent-session.d.ts` | Widened `sendUserMessage`, `followUp`, `steer`, `PromptOptions` to accept `DocumentContent` |

### Specs added

| Path | Purpose |
|---|---|
| `specs/changes/multimodal-native-pdf/specs/models/spec.md` | Model input declarations, pi-ai patches |
| `specs/changes/multimodal-native-pdf/specs/telegram/spec.md` | File message receivers |
| `specs/changes/multimodal-native-pdf/specs/agent/spec.md` | FileAttachment type, content part construction, widened prompt() |

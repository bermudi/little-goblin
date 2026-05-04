# Proposal: multimodal-native-pdf

## Motivation

Goblin can only receive text. When a user sends a PDF, image, or document via Telegram, goblin has no `message:document` or `message:photo` handler — `bot.ts` only handles `message:text`. Even if handlers were added, the agent layer calls `session.sendUserMessage(text)` with a plain string; pi-ai's `UserMessage.content` type already supports `(TextContent | ImageContent)[]` but goblin never constructs content parts.

The consequence: a PDF must be manually extracted to text via `pdftotext` and fed to the LLM as a string. The LLM never sees the actual document — it reasons over extracted line noise. This defeats the purpose of vision-capable models and native document APIs (Anthropic's `pdfs-2024-09-25` beta, OpenAI Responses' `input_file`).

The goal: let the user send a PDF or image in Telegram, and have the LLM actually *see* it — native bytes all the way through.

## Scope

This change adds an end-to-end pipeline for multimodal file attachments:

1. **pi-ai patches** — Add `DocumentContent` type to pi-ai, widen `UserMessage.content` and `ToolResultMessage.content` unions, add `"document"` to `Model.input`. Wire `DocumentContent` through the Anthropic provider (`type: "document"` content blocks with beta header) and the OpenAI Responses provider (`type: "input_file"` with `file_data`). Applied via `bun patch`.

2. **Telegram file receivers** — Add `bot.on("message:document")` and `bot.on("message:photo")` handlers that download files from Telegram, base64-encode the bytes, and route to the existing agent pipeline.

3. **Agent content part construction** — Modify `AgentRunner.prompt()` to accept and forward file attachments alongside text, constructing `(TextContent | ImageContent | DocumentContent)[]` arrays for `session.sendUserMessage()`.

4. **Model config updates** — Add `"document"` to `Model.input` for Anthropic direct and OpenAI Responses models in `src/agent/models.ts`.

### Capabilities affected

| Capability | Change |
|---|---|
| **models** | ADDED: model entries declare document support via `input: ["text", "image", "document"]` |
| **telegram** | ADDED: `message:document` and `message:photo` handlers |
| **agent** | MODIFIED: `AgentRunner.prompt()` accepts optional file attachments and constructs content parts |
| **pi-host** | ADDED: pi-ai patches for `DocumentContent` type and provider wiring |

## Non-Goals

- **OpenAI Chat Completions native document support** — Deferred. The Chat Completions API requires file upload via `POST /v1/files` before referencing by `file_id`. This infrastructure doesn't exist in pi-ai. The Responses API path covers OpenAI models.
- **Audio transcription** — Not in scope. The `message:voice` handler is deferred to a future change.
- **Large file handling (>50MB)** — Not in scope. Telegram's bot API limits files to 20MB. The Responses API limits files to 50MB.
- **Multi-file messages** — A single user message with multiple attachments works at the protocol level but is left to agent behavior, not this change's scope.
- **pi-mono upstreaming** — The patches are applied via `bun patch` for immediate use. Upstream PR is a follow-on activity, not this change.

## Approach

The change follows the OpenClaw pattern of keeping multimodal logic *outside* the agent loop (the agent loop itself stays text-only), but crucially differs in one respect: the content parts reach the LLM *as native bytes*, not as extracted text descriptions. For images, pi-ai already has this working end-to-end — goblin just needs to wire the Telegram receiver. For PDFs/documents, we add `DocumentContent` to pi-ai via patch.

```
Telegram file message
  → download file via getFile()
  → base64-encode bytes
  → construct content parts [{ type: "text", ... }, { type: "document", ... }]
  → session.sendUserMessage(contentParts)
    → pi-ai provider encodes to native API format
      → Anthropic: { type: "document", source: { type: "base64", ... } }
      → OpenAI Responses: { type: "input_file", file_data: "data:...;base64,..." }
      → LLM sees native PDF/image bytes
```

The `bun patch` approach means no fork, no upstream dependency, immediate delivery. Patches apply automatically on `bun install`. When pi-mono bumps versions, the patch may need regeneration — this is the acceptable trade-off for solo-project velocity.

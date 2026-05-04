# models

## ADDED Requirements

### Requirement: Model entries declare document input capability

Models capable of processing documents natively SHALL include `"document"` in their `Model.input` array.

#### Scenario: Anthropic direct models

- **WHEN** an Anthropic direct model entry is defined (e.g., `anthropic/claude-sonnet-4.6`)
- **THEN** its `input` array SHALL be `["text", "image", "document"]`

#### Scenario: OpenAI Responses models

- **WHEN** an OpenAI Responses model entry is defined (e.g., `openai/gpt-5.4`)
- **THEN** its `input` array SHALL be `["text", "image", "document"]`

#### Scenario: Models without native document support

- **WHEN** a model entry is defined for a provider that does not support native documents (e.g., Poe, OpenRouter)
- **THEN** its `input` array SHALL NOT include `"document"`

### Requirement: pi-ai DocumentContent type

The pi-ai type system SHALL include a `DocumentContent` interface with `type: "document"`, base64-encoded `data`, and a `mimeType` string. The `UserMessage.content` union SHALL be widened to `string | (TextContent | ImageContent | DocumentContent)[]`, the `ToolResultMessage.content` union SHALL be widened to `(TextContent | ImageContent | DocumentContent)[]`, and `Model.input` SHALL accept `"document"` as a valid member.

#### Scenario: Type imports compile

- **WHEN** goblin code imports `DocumentContent` from `@mariozechner/pi-ai`
- **THEN** the type SHALL resolve with fields `type: "document"`, `data: string`, `mimeType: string`, and optional `filename?: string`

#### Scenario: UserMessage.content accepts document parts

- **WHEN** a `UserMessage` is constructed with `content: [{ type: "text", text: "..." }, { type: "document", data: "...", mimeType: "application/pdf" }]`
- **THEN** TypeScript SHALL compile without error

### Requirement: pi-ai provider document encoding — Anthropic

The Anthropic provider SHALL encode `DocumentContent` as an Anthropic document content block `{ type: "document", source: { type: "base64", media_type: "<mimeType>", data: "<data>" } }`. When any user message in the request contains a document, the provider SHALL inject the `anthropic-beta: pdfs-2024-09-25` header.

#### Scenario: PDF in user message

- **WHEN** an Anthropic model receives a user message with a `DocumentContent` part where `mimeType === "application/pdf"`
- **THEN** the API request SHALL include `anthropic-beta: pdfs-2024-09-25` in the headers
- **AND** the user message SHALL be encoded as a content block array including `{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "<base64>" } }`

#### Scenario: No documents in request

- **WHEN** an Anthropic request contains no `DocumentContent` parts
- **THEN** the `anthropic-beta: pdfs-2024-09-25` header SHALL NOT be present

### Requirement: pi-ai provider document encoding — OpenAI Responses

The OpenAI Responses provider SHALL encode `DocumentContent` as an `input_file` content part with `file_data` set to a data URL `data:<mimeType>;base64,<data>` and `filename` from the `DocumentContent.filename` field (or `"document"` if not set).

#### Scenario: PDF in user message via Responses

- **WHEN** an OpenAI Responses model receives a user message with a `DocumentContent` part
- **THEN** the `input` array SHALL include `{ type: "input_file", filename: "<name>", file_data: "data:application/pdf;base64,<data>", detail: "auto" }`

#### Scenario: Document filtering by model input capability

- **WHEN** a model's `input` array does not include `"document"` and a message contains a `DocumentContent` part
- **THEN** the `input_file` SHALL be filtered out of the content array before the API request

### Requirement: pi-coding-agent sendUserMessage widened for DocumentContent

The `AgentSession.sendUserMessage()`, `followUp()`, and `steer()` signatures in pi-coding-agent SHALL be widened to accept `DocumentContent` alongside `ImageContent`. Specifically:

- `sendUserMessage(content: string | (TextContent | ImageContent | DocumentContent)[], ...)`
- `followUp(text: string, images?: (ImageContent | DocumentContent)[])`
- `steer(text: string, images?: (ImageContent | DocumentContent)[])`
- `PromptOptions.images?: (ImageContent | DocumentContent)[]`

#### Scenario: sendUserMessage accepts document parts

- **WHEN** goblin calls `session.sendUserMessage([{ type: "text", text: "..." }, { type: "document", data: "...", mimeType: "application/pdf" }])`
- **THEN** TypeScript SHALL compile without error

#### Scenario: followUp accepts document images

- **WHEN** goblin calls `session.followUp("Read this", [{ type: "document", data: "...", mimeType: "application/pdf" }])`
- **THEN** TypeScript SHALL compile without error

### Requirement: pi patches managed via bun patch

The pi-ai and pi-coding-agent changes described above SHALL be applied as `bun patch` patches in the goblin repository. The patch files SHALL be committed so that `bun install` automatically applies them.

#### Scenario: Clean install applies patches

- **WHEN** a developer runs `bun install` on a fresh clone
- **THEN** both `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` in `node_modules/` SHALL include the `DocumentContent` type and provider changes

#### Scenario: Patch regeneration on version bump

- **WHEN** a pi-* package version is bumped in `package.json` and `bun install` fails to apply the stored patch
- **THEN** the failure SHALL be visible as a `bun install` error (patches don't silently degrade)

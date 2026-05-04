# agent

## ADDED Requirements

### Requirement: FileAttachment type for incoming Telegram files

The agent module SHALL export a `FileAttachment` interface with fields `data: string` (base64), `mimeType: string`, and optional `filename: string`. This type SHALL be used to pass file downloads from the Telegram layer to the agent pipeline.

#### Scenario: FileAttachment used for PDF

- **WHEN** a PDF is received from Telegram
- **THEN** `FileAttachment` SHALL be `{ data: "<base64>", mimeType: "application/pdf", filename: "report.pdf" }`

#### Scenario: FileAttachment used for photo

- **WHEN** a photo is received from Telegram
- **THEN** `FileAttachment` SHALL be `{ data: "<base64>", mimeType: "image/jpeg" }` (no filename)

### Requirement: Content part construction from FileAttachment

The agent layer SHALL construct `TextContent`, `ImageContent`, or `DocumentContent` parts from a `FileAttachment` based on its `mimeType`:

- `image/*` → `ImageContent` with `{ type: "image", data, mimeType }`
- `application/pdf` → `DocumentContent` with `{ type: "document", data, mimeType, filename }`
- All other MIME types → `DocumentContent` with the detected MIME type, letting the provider/model filter by capability

#### Scenario: JPEG photo → ImageContent

- **WHEN** a `FileAttachment` with `mimeType: "image/jpeg"` is resolved
- **THEN** the content part SHALL be `{ type: "image", data: "<base64>", mimeType: "image/jpeg" }`

#### Scenario: PDF → DocumentContent

- **WHEN** a `FileAttachment` with `mimeType: "application/pdf"` is resolved
- **THEN** the content part SHALL be `{ type: "document", data: "<base64>", mimeType: "application/pdf", filename: "report.pdf" }`

#### Scenario: Unknown MIME → DocumentContent

- **WHEN** a `FileAttachment` with an unrecognized MIME type (e.g., `application/vnd.openxmlformats-officedocument.wordprocessingml.document`) is resolved
- **THEN** the content part SHALL be `{ type: "document", data: "<base64>", mimeType: "<detected>" }`
- **AND** the provider SHALL filter it if the model does not support documents for that MIME type

## MODIFIED Requirements

### Requirement: In-flight prompts use pi's followUp queueing

When `prompt()` is called while pi is streaming, the `AgentRunner` SHALL dispatch the new message via `AgentSession.followUp()` or `AgentSession.sendUserMessage()` using content parts. The runner MUST NOT implement its own queue.

If the call includes `FileAttachment` objects, the runner SHALL construct content parts (`TextContent`, `ImageContent`, or `DocumentContent`) and pass them as a content array. If no files are present, the runner SHALL pass a plain string (backward-compatible).

The `AgentRunner.prompt()` signature SHALL accept an optional `files?: FileAttachment[]` parameter.

#### Scenario: Text-only prompt (no files)

- **WHEN** `prompt("Hello", buffer)` is called with no files
- **THEN** the runner SHALL call `session.sendUserMessage("Hello")` or `session.followUp("Hello")` as before (behavior unchanged)

#### Scenario: Prompt with photo

- **WHEN** `prompt("Hello", buffer, [{ data: "<base64>", mimeType: "image/jpeg" }])` is called
- **THEN** the runner SHALL call `session.sendUserMessage([{ type: "text", text: "Hello" }, { type: "image", data: "<base64>", mimeType: "image/jpeg" }])`

#### Scenario: Prompt with PDF while streaming

- **WHEN** `prompt("Summarize this", buffer, [{ data: "<base64>", mimeType: "application/pdf", filename: "doc.pdf" }])` is called while `session.isStreaming === true`
- **THEN** the runner SHALL call `session.followUp("Summarize this", [{ type: "document", data: "<base64>", mimeType: "application/pdf" }])`

#### Scenario: Prompt with photo and no text

- **WHEN** `prompt("", buffer, [{ data: "<base64>", mimeType: "image/jpeg" }])` is called (photo with no caption)
- **THEN** the runner SHALL construct content parts with a default text like `"What do you see in this image?"` followed by the `ImageContent`

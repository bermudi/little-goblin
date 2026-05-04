# telegram

## ADDED Requirements

### Requirement: Receive document messages

The bot SHALL handle `message:document` events from Telegram. On receiving a document, the bot SHALL download the file via `ctx.api.getFile()` and `file.getFile()`, read the bytes into a buffer, and route the result to the agent pipeline as a file attachment.

#### Scenario: PDF document received

- **WHEN** a user sends a PDF document via Telegram in a session-bound chat
- **THEN** the bot SHALL download the file bytes
- **AND** construct a `FileAttachment` with `mimeType: "application/pdf"` and the base64-encoded data
- **AND** route to the agent pipeline with the optional document caption as accompanying text

#### Scenario: Document with no active session

- **WHEN** a user sends a document in a chat with no active session
- **THEN** the bot SHALL reply with a prompt to create a session via `/new`
- **AND** the file SHALL NOT be downloaded

#### Scenario: Unsupported document type

- **WHEN** a user sends a document with an unrecognized or unsupported MIME type
- **THEN** the bot SHALL still route the file to the agent
- **AND** the agent SHALL decide whether it can process the file (pi-ai filters by model capability)

#### Scenario: Download failure

- **WHEN** `ctx.api.getFile()` fails (network error, file deleted, bot lacks permission)
- **THEN** the error SHALL be logged
- **AND** the agent SHALL receive a text-only message indicating the file could not be retrieved, with the error details

### Requirement: Receive photo messages

The bot SHALL handle `message:photo` events from Telegram. The bot SHALL select the highest-resolution variant from the `photo` array, download it, and route the image as an `ImageContent` part to the agent pipeline.

#### Scenario: Photo received in active session

- **WHEN** a user sends a photo in a session-bound chat
- **THEN** the bot SHALL download the largest photo size available
- **AND** construct an `ImageContent` with `mimeType: "image/jpeg"` and base64 data
- **AND** route to the agent pipeline with the photo caption as accompanying text

#### Scenario: Photo with caption

- **WHEN** a user sends a photo with a caption "What's in this image?"
- **THEN** the content parts SHALL include a `TextContent` with the caption followed by the `ImageContent`
- **AND** the prompt text SHALL be "What's in this image?"

#### Scenario: Photo with no caption

- **WHEN** a user sends a photo with no caption
- **THEN** the content parts SHALL include an `ImageContent` with a default `TextContent` "What do you see in this image?"

### Requirement: File attachments do not block agent pipeline

File download errors SHALL NOT crash the bot, propagate to the user as unhandled exceptions, or prevent subsequent messages from being processed. The bot SHALL degrade gracefully — either passing a text-only fallback to the agent or skipping the turn with an error reply.

#### Scenario: Network error during file download

- **WHEN** a document handler encounters a network error mid-download
- **THEN** the bot SHALL reply to the user with a message indicating the download failed
- **AND** the bot SHALL continue processing subsequent messages

# route document-attached images to projectDir

## MODIFIED Requirements

- When a user sends a `message:document`, goblin treats it the same regardless of MIME type: save it to the active `projectDir`, not send it to the model as multimodal content.
- The `message:photo` handler remains the only path that delivers images directly to the model as multimodal content.
- If no `projectDir` exists when a document arrives, goblin forwards the caption as a text prompt when available, or replies: "No project directory is set. Use /project <path> to enable file saving."

#### Scenario: Image sent as document with projectDir bound

- **GIVEN** an active session with a project directory
- **WHEN** the user sends an image file via Telegram's document attachment
- **THEN** the file is saved to `projectDir/<filename>`
- **AND** the agent is notified via text prompt
- **AND** the image is NOT sent to the model as multimodal content

#### Scenario: Image sent as document without projectDir

- **GIVEN** an active session with no project directory
- **WHEN** the user sends an image file via Telegram's document attachment
- **THEN** if a caption exists, it is forwarded as a text-only prompt
- **AND** if no caption exists, the user receives: "No project directory is set. Use /project <path> to enable file saving."
- **AND** the image is NOT sent to the model

#### Scenario: Compressed photo still goes multimodal

- **GIVEN** any active session
- **WHEN** the user sends a compressed photo via `message:photo`
- **THEN** the photo is delivered to the model as multimodal content (unchanged behavior)

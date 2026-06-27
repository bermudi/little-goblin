# beta-tools

## Requirements

### Requirement: Beta tools are factory-created with bound context

The `src/tg/tools.ts` module SHALL export factory functions that create `ToolDefinition` objects with Telegram context (`chatId`, optionally `topicId` or `messageId`) baked into the tool handler closure at creation time.

#### Scenario: Send voice tool creation

- **WHEN** `createSendVoiceTool(bot, 123456)` is called
- **THEN** it SHALL return a `ToolDefinition` object
- **AND** the returned definition's `handler` SHALL be a closure that can access `chatId = 123456`

#### Scenario: React tool with message context

- **WHEN** `createReactTool(bot, 123456, 789)` is called
- **THEN** the returned tool's handler SHALL have access to both `chatId = 123456` and `messageId = 789`

### Requirement: No Telegram identifiers in tool schemas

Every β tool's `parameters` schema SHALL NOT contain `chatId`, `messageId`, or `topicId` properties. The LLM SHALL NOT be able to specify these values when calling the tool.

#### Scenario: Send voice schema inspection

- **WHEN** the schema of `createSendVoiceTool(...)` is inspected
- **THEN** `properties` SHALL contain `voiceFile` and optionally `caption`
- **AND** `properties` SHALL NOT contain `chatId`

#### Scenario: Rename topic schema for DMs

- **WHEN** `createRenameTopicTool(bot, 123456, undefined)` is called for a DM
- **THEN** it SHALL return `null` (no tool created)
- **AND** no schema exists for this tool in that session

### Requirement: Factories accept grammy bot instance

Every β tool factory SHALL accept a `Bot` instance as its first parameter, used to access `bot.api` methods within the tool handler.

#### Scenario: Send voice uses bot.api

- **WHEN** the handler of a created `send_voice` tool is invoked
- **THEN** it SHALL call `bot.api.sendVoice(chatId, ...)` with the bound `chatId`

### Requirement: Tool validates required parameters

Each tool SHALL reject calls with missing required parameters. Validation is enforced by the framework's schema layer (TypeBox via `defineTool`) before the handler is invoked.

#### Scenario: Send voice missing file

- **WHEN** `send_voice` is called with `{}` (no voiceFile)
- **THEN** the tool SHALL return a validation error indicating the missing parameter

#### Scenario: Rename topic missing title

- **WHEN** `rename_topic` is called with `{}`
- **THEN** the tool SHALL return a validation error indicating the missing parameter

### Requirement: Tools handle Telegram API errors

When a Telegram API call fails, the tool handler SHALL catch the error and return a structured result with `ok: false` and the error message, allowing the LLM to see what happened.

#### Scenario: Telegram API throws

- **WHEN** `bot.api.sendVoice` throws due to network error
- **THEN** the handler SHALL catch the error
- **AND** return `{ok: false, error: "Telegram API error: ..."}`

### Requirement: Send voice tool sends voice messages

`createSendVoiceTool(bot, chatId)` SHALL return a tool named `"send_voice"` that sends a voice file to the bound chat.

#### Scenario: Successful voice send

- **WHEN** the tool is called with `{voiceFile: "/tmp/voice.ogg", caption: "Hello"}`
- **THEN** `bot.api.sendVoice(chatId, InputFile("/tmp/voice.ogg"), {caption: "Hello"})` SHALL be invoked
- **AND** on success, return `{ok: true, messageId: <id>}`

### Requirement: Send photo tool sends images

`createSendPhotoTool(bot, chatId)` SHALL return a tool named `"send_photo"` that sends an image.

#### Scenario: Successful photo send

- **WHEN** the tool is called with `{photoFile: "/tmp/img.jpg", caption: "Screenshot"}`
- **THEN** `bot.api.sendPhoto(chatId, InputFile("/tmp/img.jpg"), {caption: "Screenshot"})` SHALL be invoked

### Requirement: Send document tool sends arbitrary files

`createSendDocumentTool(bot, chatId)` SHALL return a tool named `"send_document"` that sends a file.

#### Scenario: Successful document send

- **WHEN** the tool is called with `{documentFile: "/tmp/data.json", caption: "Data"}`
- **THEN** `bot.api.sendDocument(chatId, InputFile("/tmp/data.json"), {caption: "Data"})` SHALL be invoked

### Requirement: React tool adds emoji reactions

`createReactTool(bot, chatId, messageId)` SHALL return a tool named `"react"` that adds an emoji reaction to a specific message. If `messageId` is undefined, it SHALL return `null`.

#### Scenario: Successful reaction

- **WHEN** the tool is called with `{emoji: "👍"}`
- **THEN** `bot.api.setMessageReaction(chatId, messageId, [{type: "emoji", emoji: "👍"}])` SHALL be invoked

#### Scenario: React with wrong emoji format

- **WHEN** the tool is called with `{emoji: "thumbs_up"}` (not an emoji character)
- **THEN** the handler SHALL return an error: `"emoji must be a single emoji character"`

#### Scenario: React tool undefined messageId

- **WHEN** `createReactTool(bot, 123456, undefined)` is called
- **THEN** it SHALL return `null` (no tool created)
- **AND** no schema exists for this tool in that session

### Requirement: Rename topic tool renames forum topics

`createRenameTopicTool(bot, chatId, topicId)` SHALL return a tool named `"rename_topic"` that renames a forum topic. If `topicId` is undefined, it SHALL return `null`.

#### Scenario: Rename in topic

- **WHEN** called with `topicId = 5`
- **AND** the tool is called with `{title: "New Topic Name"}`
- **THEN** `bot.api.editForumTopic(chatId, topicId, { name: "New Topic Name" })` SHALL be invoked

#### Scenario: Called for DM (no topic)

- **WHEN** called with `topicId = undefined`
- **THEN** it SHALL return `null`

### Requirement: Chat action tool sets typing status

`createChatActionTool(bot, chatId)` SHALL return a tool named `"chat_action"` that sets a chat action (typing, uploading_photo, etc.).

#### Scenario: Set typing

- **WHEN** the tool is called with `{action: "typing"}`
- **THEN** `bot.api.sendChatAction(chatId, "typing")` SHALL be invoked

#### Scenario: Invalid action

- **WHEN** the tool is called with `{action: "invalid_action"}`
- **THEN** it SHALL return an error listing valid actions

### Requirement: Bot.ts instantiates tools per session

`src/bot.ts` SHALL instantiate β tools for each Telegram session using the session's `chatId` (and `topicId`/`messageId` where applicable) and pass them to `AgentRunner`.

#### Scenario: DM session tool creation

- **WHEN** a message is received in a DM
- **THEN** `createSendVoiceTool`, `createSendPhotoTool`, `createSendDocumentTool`, `createChatActionTool` SHALL be created with the session's `chatId`
- **AND** `createRenameTopicTool` SHALL return `null` (no topic in DMs)

#### Scenario: Topic session tool creation

- **WHEN** a message is received in a topic
- **THEN** `createRenameTopicTool(bot, chatId, topicId)` SHALL return a tool (not `null`)
- **AND** all other tools SHALL be created with the session's `chatId`

#### Scenario: Tools passed to AgentRunner

- **WHEN** the runner is created for a session
- **THEN** the array of created β tools SHALL be passed as `customTools`

### Requirement: AgentRunner passes beta tools to pi

`AgentRunner` SHALL receive the β tools array and pass them to `createAgentSession({ customTools })` unchanged.

#### Scenario: Beta tools available to LLM

- **WHEN** an `AgentRunner` is created with β tools
- **THEN** the LLM SHALL see those tools in its context
- **AND** when the LLM calls a β tool, the bound `chatId` SHALL be used automatically

### Requirement: Text-to-speech tool generates voice from text

`createTextToSpeechTool()` SHALL return a tool named `"text_to_speech"` that accepts `text` (arbitrary string) or `file` (absolute path to a text file) and generates an MP3 voice file via Microsoft Edge TTS. The tool SHALL NOT send the voice message — it returns the file path so the model can chain it with `send_voice`.

#### Scenario: Generate voice from text

- **WHEN** the tool is called with `{ text: "Hello, world!" }`
- **THEN** the text SHALL be passed to `uvx edge-tts` (via a temp file with `--file`) with `--voice <VOICE_NAME> --write-media <tmpPath>`
- **AND** on success, return `{ ok: true, audioPath: "<tmpPath>" }`

#### Scenario: Generate voice from file

- **WHEN** the tool is called with `{ file: "/home/user/notes.md" }`
- **AND** the file exists and is readable
- **THEN** the tool SHALL read the file contents
- **AND** pass the contents to `uvx edge-tts` (via a temp file with `--file`)
- **AND** on success, return `{ ok: true, audioPath: "<tmpPath>" }`

#### Scenario: File does not exist

- **WHEN** the tool is called with `{ file: "/nonexistent/file.txt" }`
- **THEN** return `{ ok: false, error: "file does not exist: /nonexistent/file.txt" }`

#### Scenario: Neither text nor file provided

- **WHEN** the tool is called with `{}` (no text and no file)
- **THEN** the handler SHALL return `{ ok: false, error: "either text or file is required" }`

#### Scenario: Both text and file provided

- **WHEN** the tool is called with `{ text: "hello", file: "/path/to/file.txt" }`
- **THEN** the `text` parameter SHALL take precedence
- **AND** the file parameter SHALL be ignored

#### Scenario: Edge TTS subprocess fails

- **WHEN** `uvx edge-tts` exits with a non-zero code
- **THEN** return `{ ok: false, error: "TTS generation failed: <stderr or exit code>" }`

### Requirement: Text-to-speech tool uses configurable voice

The tool SHALL use the voice configured by the `VOICE_NAME` environment variable, defaulting to `en-US-EmmaMultilingualNeural`.

#### Scenario: Default voice

- **WHEN** `VOICE_NAME` is not set
- **THEN** the edge-tts subprocess SHALL receive `--voice en-US-EmmaMultilingualNeural`

#### Scenario: Custom voice

- **WHEN** `VOICE_NAME=en-US-AndrewMultilingualNeural`
- **THEN** the edge-tts subprocess SHALL receive `--voice en-US-AndrewMultilingualNeural`

### Requirement: Text-to-speech tool appears in the MessageBuffer status line

The `text_to_speech` tool SHALL be visible in the MessageBuffer status line under all visibility levels that include tool operations (standard, verbose, debug — not minimal or none). Like read/write/bash, it helps the user understand what goblin is doing during a potentially multi-second TTS call.

#### Scenario: Tool appears in status line

- **WHEN** the model invokes `text_to_speech` under the `standard` visibility level
- **THEN** the tool name SHALL appear in the status line during execution
- **AND** transition from 🔧 to ✅ on completion

### Requirement: Text-to-speech tool factory signature matches existing pattern

`createTextToSpeechTool()` SHALL accept no Telegram-context parameters (no `chatId`, `topicId`, `messageId`) since the tool has no Telegram-specific side effects. The factory MAY accept an optional `voiceName?: string` override for testing; when provided, it takes precedence over `process.env.VOICE_NAME`.

#### Scenario: Tool created without Telegram context

- **WHEN** `createTextToSpeechTool()` is called
- **THEN** it SHALL return a `ToolDefinition` object
- **AND** the definition's handler SHALL NOT access `chatId` or any Telegram API

#### Scenario: Tool created with voiceName override

- **WHEN** `createTextToSpeechTool({ voiceName: "en-US-TestNeural" })` is called
- **THEN** the tool SHALL use `"en-US-TestNeural"` for all TTS calls
- **AND** SHALL ignore `process.env.VOICE_NAME`

### Requirement: AgentRunner includes text_to_speech in custom tools

`AgentRunner` SHALL include `createTextToSpeechTool()` in the `customTools` array passed to `createAgentSession`, alongside the existing β-tools and memory tools. The tool SHALL be available to the model in every session.

#### Scenario: Tool available in all sessions

- **WHEN** an `AgentRunner` is initialized for any session
- **THEN** the `customTools` array SHALL include a `text_to_speech` tool
- **AND** the model SHALL see `text_to_speech` in its available tools

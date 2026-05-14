# beta-tools

## ADDED Requirements

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

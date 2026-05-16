# beta-tools

## MODIFIED Requirements

### Requirement: Beta tools are factory-created with bound context

The `src/tg/tools.ts` module SHALL export factory functions that create AI SDK `tool()` definitions with Telegram context (`chatId`, optionally `topicId` or `messageId`) baked into the tool handler closure at creation time.

#### Scenario: Send voice tool creation

- **WHEN** `createSendVoiceTool(bot, 123456)` is called
- **THEN** it SHALL return an AI SDK tool definition
- **AND** the returned definition's `execute` SHALL be a closure that can access `chatId = 123456`

### Requirement: No Telegram identifiers in tool schemas

Every β tool's `inputSchema` (zod schema) SHALL NOT contain `chatId`, `messageId`, or `topicId` properties. The LLM SHALL NOT be able to specify these values when calling the tool.

#### Scenario: Send voice schema inspection

- **WHEN** the schema of `createSendVoiceTool(...)` is inspected
- **THEN** it SHALL contain `voiceFile` and optionally `caption`
- **AND** SHALL NOT contain `chatId`

### Requirement: Factories accept grammy bot instance

Every β tool factory SHALL accept a `Bot` instance as its first parameter, used to access `bot.api` methods within the tool handler.

#### Scenario: Send voice uses bot.api

- **WHEN** the handler of a created `send_voice` tool is invoked
- **THEN** it SHALL call `bot.api.sendVoice(chatId, ...)` with the bound `chatId`

### Requirement: Tool validates required parameters

Each tool SHALL reject calls with missing required parameters. Validation is enforced by AI SDK's zod schema layer before `execute` is invoked.

#### Scenario: Send voice missing file

- **WHEN** `send_voice` is called with `{}` (no voiceFile)
- **THEN** the tool SHALL return a validation error indicating the missing parameter

### Requirement: Tools handle Telegram API errors

When a Telegram API call fails, the tool handler SHALL catch the error and return a structured result with `ok: false` and the error message.

#### Scenario: Telegram API throws

- **WHEN** `bot.api.sendVoice` throws due to network error
- **THEN** the handler SHALL catch the error
- **AND** return `{ok: false, error: "Telegram API error: ..."}`

### Requirement: Bot.ts instantiates tools per session

`src/bot.ts` SHALL instantiate β tools for each Telegram session and pass them to `AgentRunner` as AI SDK tool definitions.

#### Scenario: Tools passed to AgentRunner

- **WHEN** the runner is created for a session
- **THEN** the array of created β tools SHALL be passed as `customTools`

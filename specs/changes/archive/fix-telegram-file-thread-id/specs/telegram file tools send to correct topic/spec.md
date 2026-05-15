# telegram file tools send to correct topic

## ADDED Requirements

- `createSendVoiceTool(bot, chatId, topicId?)`, `createSendPhotoTool(bot, chatId, topicId?)`, and `createSendDocumentTool(bot, chatId, topicId?)` accept an optional `topicId: number | undefined` parameter.
- When `topicId` is provided (type `number`), the tool passes `message_thread_id: topicId` in the Telegram API call so the file is posted in the correct forum topic.
- When `topicId` is absent or `undefined`, the tool behaves exactly as before: no `message_thread_id` is passed.

#### Scenario: File posted in a forum topic with topicId set

- **GIVEN** a supergroup topic with `topicId = 42`
- **WHEN** the agent invokes `send_photo` via the tool
- **THEN** the Telegram API call includes `message_thread_id: 42`
- **AND** the image appears in topic 42, not the main chat

#### Scenario: File posted in a DM without topicId

- **GIVEN** a direct message (no topic)
- **WHEN** the agent invokes `send_document` via the tool
- **THEN** the Telegram API call does NOT include `message_thread_id`
- **AND** the file appears in the DM as before

## MODIFIED Requirements

- `src/bot.ts` `getBetaTools()` passes `locator.topicId` as the third argument to `createSendVoiceTool`, `createSendPhotoTool`, and `createSendDocumentTool`.

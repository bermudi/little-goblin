# Beta Tools — Tasks

## Phase 1: Tool factory infrastructure

- [x] Create `src/tg/tools.ts` with the six factory function signatures (exports only, empty implementations that throw "not implemented").
- [x] Define the `ToolDefinition` return type structure (name, description, parameters JSON schema, handler function).
- [x] Add type imports for `grammy` (`Bot`, `InputFile`) and `@mariozechner/pi-coding-agent` (`ToolDefinition`).
- [x] Stub implementations that close over `chatId`/`topicId`/`messageId` but throw in handler.
- [x] Verify `bun run typecheck` passes.

Commit: `phase 1: beta tools factory signatures and structure`

## Phase 2: Send voice implementation

- [x] Implement `createSendVoiceTool(bot, chatId)`:
  - Parameters schema: `{voiceFile: {type: "string"}, caption: {type: "string"}}`, required: `["voiceFile"]`.
  - Handler validates `voiceFile` exists, reads file, calls `bot.api.sendVoice(chatId, InputFile(voiceFile), {caption})`.
  - Returns `{ok: true, messageId: result.message_id}` on success.
  - Catches errors, returns `{ok: false, error: err.message}`.
- [x] Unit test in `src/tg/tools.test.ts`:
  - Mock `bot.api.sendVoice`.
  - Assert schema has no `chatId` property.
  - Assert handler calls API with bound `chatId` (123) not any argument.
  - Assert file read and API call happen.
  - Assert error handling returns structured result.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: implement send_voice beta tool`

## Phase 3: Remaining send tools (photo, document)

- [x] Implement `createSendPhotoTool(bot, chatId)` following same pattern as send_voice.
- [x] Implement `createSendDocumentTool(bot, chatId)` following same pattern.
- [x] Unit tests for both with mocked API and file handling.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: implement send_photo and send_document beta tools`

## Phase 4: React and chat action tools

- [x] Implement `createReactTool(bot, chatId, messageId)`:
  - Validate `emoji` is a single emoji character (regex `/^\p{Emoji}$/u`).
  - Call `bot.api.setMessageReaction(chatId, messageId, [{type: "emoji", emoji}])`.
  - Return structured result on success/error.
- [x] Implement `createChatActionTool(bot, chatId)`:
  - Validate `action` is in allowed list: typing, upload_photo, record_voice, upload_document.
  - Call `bot.api.sendChatAction(chatId, action)`.
  - Return structured result.
- [x] Unit tests for both with mocked API.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: implement react and chat_action beta tools`

## Phase 5: Rename topic tool with DM null handling

- [x] Implement `createRenameTopicTool(bot, chatId, topicId?)`:
  - If `topicId === undefined`, return `null` immediately.
  - Otherwise, return `ToolDefinition` with parameters `{title: string}`.
  - Handler calls `bot.api.editForumTopic(chatId, topicId, { name: title })` (the actual grammy API; the spec/design's `setForumTopicTitle` does not exist).
  - Return structured result.
- [x] Unit test:
  - Assert `createRenameTopicTool(bot, 123, undefined)` returns `null`.
  - Assert `createRenameTopicTool(bot, 123, 5)` returns a `ToolDefinition`.
  - Assert schema has no `topicId` property.
  - Assert handler calls API with bound `topicId` (5), not any argument.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: implement rename_topic beta tool with DM null handling`

## Phase 6: Wire tools into bot.ts

- [x] In `src/bot.ts`, import all tool factories from `./tg/tools.ts`.
- [x] After session resolution (where we have `ctx.chat.id`, `ctx.message?.message_thread_id`, `ctx.message?.message_id`), instantiate tools:
  ```typescript
  const chatId = ctx.chat.id;
  const topicId = ctx.message?.message_thread_id;
  const messageId = ctx.message?.message_id;
  const betaTools = [
    createSendVoiceTool(bot, chatId),
    createSendPhotoTool(bot, chatId),
    createSendDocumentTool(bot, chatId),
    createReactTool(bot, chatId, messageId),
    createRenameTopicTool(bot, chatId, topicId), // returns null in DMs
    createChatActionTool(bot, chatId),
  ].filter(Boolean); // remove nulls
  ```
- [x] Pass `betaTools` array to `new AgentRunner(cfg, sessionId, betaTools)`.
- [x] Verify AgentRunner passes `customTools` to pi's `createAgentSession` unchanged.
- [x] Smoke test end-to-end: run `bun run dev`, verify a message still gets a reply (using the minimal callback from `agent-runner` phase 5).
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: wire beta tools into bot.ts per-session instantiation`

## Phase 7: Validate and archive

- [x] `litespec validate beta-tools` (strict).
- [x] Review spec deltas vs implementation — ensure all 13 requirements are covered.
- [x] `litespec preview beta-tools` to see canonical spec diff.
- [x] `litespec archive beta-tools` when satisfied.

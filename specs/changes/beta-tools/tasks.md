# Beta Tools — Tasks

## Phase 1: Tool factory infrastructure

- [ ] Create `src/tg/tools.ts` with the six factory function signatures (exports only, empty implementations that throw "not implemented").
- [ ] Define the `ToolDefinition` return type structure (name, description, parameters JSON schema, handler function).
- [ ] Add type imports for `grammy` (`Bot`, `InputFile`) and `@mariozechner/pi-coding-agent` (`ToolDefinition`).
- [ ] Stub implementations that close over `chatId`/`topicId`/`messageId` but throw in handler.
- [ ] Verify `bun run typecheck` passes.

Commit: `phase 1: beta tools factory signatures and structure`

## Phase 2: Send voice implementation

- [ ] Implement `createSendVoiceTool(bot, chatId)`:
  - Parameters schema: `{voiceFile: {type: "string"}, caption: {type: "string"}}`, required: `["voiceFile"]`.
  - Handler validates `voiceFile` exists, reads file, calls `bot.api.sendVoice(chatId, InputFile(voiceFile), {caption})`.
  - Returns `{ok: true, messageId: result.message_id}` on success.
  - Catches errors, returns `{ok: false, error: err.message}`.
- [ ] Unit test in `src/tg/tools.test.ts`:
  - Mock `bot.api.sendVoice`.
  - Assert schema has no `chatId` property.
  - Assert handler calls API with bound `chatId` (123) not any argument.
  - Assert file read and API call happen.
  - Assert error handling returns structured result.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: implement send_voice beta tool`

## Phase 3: Remaining send tools (photo, document)

- [ ] Implement `createSendPhotoTool(bot, chatId)` following same pattern as send_voice.
- [ ] Implement `createSendDocumentTool(bot, chatId)` following same pattern.
- [ ] Unit tests for both with mocked API and file handling.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: implement send_photo and send_document beta tools`

## Phase 4: React and chat action tools

- [ ] Implement `createReactTool(bot, chatId, messageId)`:
  - Validate `emoji` is a single emoji character (regex `/^\p{Emoji}$/u`).
  - Call `bot.api.setMessageReaction(chatId, messageId, [{type: "emoji", emoji}])`.
  - Return structured result on success/error.
- [ ] Implement `createChatActionTool(bot, chatId)`:
  - Validate `action` is in allowed list: typing, upload_photo, record_voice, upload_document.
  - Call `bot.api.sendChatAction(chatId, action)`.
  - Return structured result.
- [ ] Unit tests for both with mocked API.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: implement react and chat_action beta tools`

## Phase 5: Rename topic tool with DM null handling

- [ ] Implement `createRenameTopicTool(bot, chatId, topicId?)`:
  - If `topicId === undefined`, return `null` immediately.
  - Otherwise, return `ToolDefinition` with parameters `{title: string}`.
  - Handler calls `bot.api.setForumTopicTitle(chatId, topicId, title)`.
  - Return structured result.
- [ ] Unit test:
  - Assert `createRenameTopicTool(bot, 123, undefined)` returns `null`.
  - Assert `createRenameTopicTool(bot, 123, 5)` returns a `ToolDefinition`.
  - Assert schema has no `topicId` property.
  - Assert handler calls API with bound `topicId` (5), not any argument.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: implement rename_topic beta tool with DM null handling`

## Phase 6: Wire tools into bot.ts

- [ ] In `src/bot.ts`, import all tool factories from `./tg/tools.ts`.
- [ ] After session resolution (where we have `ctx.chat.id`, `ctx.message?.message_thread_id`, `ctx.message?.message_id`), instantiate tools:
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
- [ ] Pass `betaTools` array to `new AgentRunner(cfg, sessionId, betaTools)`.
- [ ] Verify AgentRunner passes `customTools` to pi's `createAgentSession` unchanged.
- [ ] Smoke test end-to-end: run `bun run dev`, verify a message still gets a reply (using the minimal callback from `agent-runner` phase 5).
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: wire beta tools into bot.ts per-session instantiation`

## Phase 7: Validate and archive

- [ ] `litespec validate beta-tools` (strict).
- [ ] Review spec deltas vs implementation — ensure all 13 requirements are covered.
- [ ] `litespec preview beta-tools` to see canonical spec diff.
- [ ] `litespec archive beta-tools` when satisfied.

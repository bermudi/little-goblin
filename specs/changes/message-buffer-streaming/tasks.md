# Message Buffer & Streaming — Tasks

## Phase 1: MessageBuffer skeleton and TurnCallbacks

- [x] Create `src/tg/buffer.ts` with `MessageBuffer` class implementing `TurnCallbacks`:
  - Constructor accepts `bot: Bot`, `chatId: number`, `options?: {visibility?: string}`
  - All callback methods stubbed (empty)
  - Internal state tracking: `statusMessageId`, `responseMessageId`, `accumulatedText`, `toolStates: Map<string, string>`, `lastEditTime`, `isStreaming`
- [x] Add `src/tg/buffer.test.ts` with basic instantiation test.
- [x] Verify `bun run typecheck` passes.

Commit: `phase 1: MessageBuffer skeleton with TurnCallbacks interface`

## Phase 2: Status line accumulation and state machine

- [x] Implement `onToolStart(name, args)`: add to `toolStates` with state "running" (🔧).
- [x] Implement `onToolEnd(name, isError)`: update state to "success" (✅) or "error" (❌).
- [x] Implement `onAgentEnd()`: clear `isStreaming`, flush final status.
- [x] Build status line string from `toolStates`: format "✅ read 🔧 bash ✍️ composing".
- [x] Unit test: verify state machine transitions and string formatting.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: status line state machine with emoji indicators`

## Phase 3: Status line editing with throttle

- [x] Implement `flushStatus()`: call `bot.api.sendMessage` (first) or `editMessageText` (subsequent), track `statusMessageId`.
- [x] Add throttle: skip edit if `< 1000ms` since `lastEditTime`, unless forced (on `onAgentEnd`).
- [x] Handle rate limit (429): log warning, skip this edit, continue.
- [x] Handle deleted message error: log warning, reset `statusMessageId` to create new message next time.
- [x] Unit test with mocked bot API: verify throttle, verify edit vs send, verify error handling.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: status line editing with ~1/sec throttle and error recovery`

## Phase 4: Response text accumulation and streaming

- [x] Implement `onTextDelta(delta)`: append to `accumulatedText`.
- [x] Implement `flushResponse()`: edit `responseMessageId` with current `accumulatedText`.
- [x] On first `onTextDelta`: call `bot.api.sendMessage` to create response message, track ID.
- [x] Add simple throttle for response edits (e.g., max 5 edits/sec) to avoid spam.
- [x] Unit test: verify text accumulation, message creation, edits.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: response text streaming with edits`

## Phase 5: 4096 rollover for response messages

- [x] Implement `maybeRollover()`: check `accumulatedText.length > 4096`.
- [x] If over threshold: send current text as final edit, create new message for remaining text, reset `accumulatedText` to overflow portion.
- [x] Ensure Unicode safety (don't split surrogate pairs).
- [x] Unit test: verify rollover at 4096, verify content preserved across messages.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: 4096 character rollover for response messages`

## Phase 6: Big output file escape (>20KB)

- [ ] Implement big output detection: `accumulatedText.length > 20000`.
- [ ] When triggered: write text to temp file, send as `InputFile` via `bot.api.sendDocument`, send summary text via `bot.api.sendMessage`.
- [ ] Summary format: first 500 chars + "... [truncated, see attached reply.md]".
- [ ] Clean up temp file after send (or use tmpdir with cleanup).
- [ ] Unit test with mocked file system and bot API.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: big output escapes to file attachment`

## Phase 7: Tool visibility filtering

- [ ] Define visibility levels and tool lists:
  ```typescript
  const visibilityTools: Record<string, string[]> = {
    none: [],
    minimal: ['bash', 'write', 'edit', 'spawn_subagent'],
    standard: ['bash', 'write', 'edit', 'read', 'grep', 'spawn_subagent'], // α tools only
    verbose: ['bash', 'write', 'edit', 'read', 'grep', 'spawn_subagent', 'revive_subagent', 'list_subagents'], // α + γ tools
    debug: ['*'] // everything
  };
  ```
- [ ] Implement `shouldShowTool(name, visibility)`: check if tool is in list.
- [ ] Modify `onToolStart`/`onToolEnd`: only update state if `shouldShowTool`.
- [ ] Default visibility: "standard".
- [ ] Load visibility from `~/goblin/config.json` (create if missing).
- [ ] Unit test: verify filtering at each level.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 7: tool visibility config with 5 levels`

## Phase 8: Chat action refresh

- [ ] Implement `startChatAction()`: set interval (4s) calling `bot.api.sendChatAction(chatId, 'typing')`.
- [ ] Implement `stopChatAction()`: clear interval.
- [ ] Call `startChatAction()` on first `onTextDelta` (if not already started).
- [ ] Call `stopChatAction()` on `onAgentEnd`.
- [ ] Unit test: verify interval behavior, verify stop on end.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 8: chat action refresh every ~4s`

## Phase 9: Wire into bot.ts and config

- [ ] In `src/tg/mod.ts`, export `MessageBuffer` from `./buffer.ts` (barrel export).
- [ ] In `src/bot.ts`, import `MessageBuffer` from `./tg/mod.ts`.
- [ ] After session resolution, create buffer: `const buffer = new MessageBuffer(bot, ctx.chat.id, {visibility: config.toolVisibility})`.
- [ ] Pass buffer as `TurnCallbacks` to `runner.prompt()`.
- [ ] Add `toolVisibility` to config loader and default config.
- [ ] Smoke test end-to-end: run bot, verify status line appears during tool calls, verify response streams.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 9: integrate MessageBuffer into bot.ts`

## Phase 10: Validate and archive

- [ ] `litespec validate message-buffer-streaming` (strict).
- [ ] Manual review of spec deltas vs implementation.
- [ ] `litespec preview message-buffer-streaming`.
- [ ] `litespec archive message-buffer-streaming` when satisfied.

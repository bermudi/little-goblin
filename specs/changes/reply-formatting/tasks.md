# reply-formatting — Tasks

## Phase 1: Format module and escape helpers

- [x] Create `src/tg/format.ts` with `escapeMdV2(text)` — escapes MarkdownV2-special chars outside code spans and fenced blocks
- [x] Add `stripMdV2(text)` — removes MarkdownV2 formatting markers for plain-text fallback
- [x] Add `SystemTag` type (`"ok" | "error" | "warn" | "info" | "queued"`)
- [x] Add `systemReply(text, tag)` — wraps text as `` `[tag]` `` + escaped text
- [x] Add `sendSystemReply(message, text, tag, opts?)` — formats + sends via `message.reply` with `parse_mode` and `disable_notification`, plain-text fallback on 400
- [x] Create `src/tg/format.test.ts` with tests for all four functions
- [x] Export `sendSystemReply`, `systemReply`, `escapeMdV2`, `SystemTag` from `src/tg/mod.ts` (note: `stripMdV2` is internal to `format.ts`, used only by `buffer.ts` via direct import — not exported from the barrel)
- [x] Run `bun test src/tg/format.test.ts` — all tests pass
- [x] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 2: Extend TelegramIntakeMessage and wire bot.ts

- [ ] Add `ReplyOpts` type (`{ parse_mode?: string; disable_notification?: boolean }`) to `src/tg/intake.ts`
- [ ] Change `TelegramIntakeMessage.reply` signature to `(text: string, opts?: ReplyOpts) => Promise<void>`
- [ ] Update `intakeMessageFromCtx` in `src/bot.ts` — pass `opts` through to `ctx.reply(text, opts)`
- [ ] Update `replyNoActiveSession` in `src/bot.ts` — pass `opts` through to `ctx.reply(text, opts)`
- [ ] Update `makeMessage` helper in `src/tg/intake.test.ts` — accept and ignore optional `opts` parameter
- [ ] Run `bun test` — all existing tests still pass (backward-compatible change)
- [ ] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 3: Add MarkdownV2 to MessageBuffer response path

- [ ] Add `parse_mode: "MarkdownV2"` to response `sendMessage` and `editMessageText` via `this.withThread({ parse_mode: "MarkdownV2" })` in `flushResponse` (response path only, not status)
- [ ] Add `stripMdV2` import to `buffer.ts`
- [ ] Add `responseIsPlainText: boolean` field to `MessageBuffer`, initialized `false`
- [ ] Add 400 parse-error detection in the response flush `catch` block — before `handleResponseError`, check for 400 + "parse"/"markdown" in description; if so, call `stripMdV2(text)`, retry with `this.withThread()` (no parse_mode), set `responseIsPlainText = true`; if retry fails, call `handleResponseError` on the retry error
- [ ] Skip MarkdownV2 (use plain `this.withThread()`) when `responseIsPlainText` is true
- [ ] Reset `responseIsPlainText = false` wherever `responseMessageId` is cleared (tool boundary seal, rollover, file escape)
- [ ] Add `{ parse_mode: "MarkdownV2" }` to `maybeRollover` head sends and `maybeFileEscape` summary send
- [ ] Add inline-code-span safety check in `maybeRollover` — if split point has odd unescaped backtick count, move split backward to before the last backtick
- [ ] Add tests in `src/tg/buffer.test.ts` for MarkdownV2 parse mode on response sends
- [ ] Add test for 400 parse-error → plain-text fallback with sticky flag (subsequent edits skip MarkdownV2)
- [ ] Add test for sticky flag reset on tool boundary seal
- [ ] Add test for rollover split avoiding inline code span break
- [ ] Verify status-line `sendMessage`/`editMessageText` calls remain plain text (no `parse_mode`) — add test asserting status sends do not include `parse_mode`
- [ ] Run `bun test src/tg/buffer.test.ts` — all tests pass
- [ ] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 4: Add tag to DispatchResult and update command handlers

- [ ] Import `SystemTag` type in `src/commands/registry.ts`
- [ ] Add optional `tag?: SystemTag` to the `replied` variant of `DispatchResult`
- [ ] Update `replied()` helper to accept optional `tag` parameter
- [ ] Set `tag: "error"` on all "Failed to ..." error replies in command handlers (new, archive, project, model, think, compact, name, resume, subagents, schedule)
- [ ] Set `tag: "info"` on usage replies and "No active session" replies in command handlers
- [ ] Set `tag: "queued"` on queue ack when streaming, `"ok"` when idle in `queueHandler`
- [ ] Set `tag: "warn"` on config-issue replies (e.g. think command "Unknown level", model "No favorites configured")
- [ ] Set `tag: "error"` on voice failure replies
- [ ] Update `src/commands/registry.test.ts` — test `tag` field propagation
- [ ] Run `bun test src/commands/` — all command tests pass
- [ ] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 5: Wire intake system replies through sendSystemReply

- [ ] Import `sendSystemReply` in `src/tg/intake.ts`
- [ ] Replace `message.reply(text)` in `replyNoActiveSession` with `sendSystemReply(message, text, "info")`
- [ ] Replace `message.reply(text)` in download-failure paths with `sendSystemReply(message, text, "error")`
- [ ] Replace `message.reply(text)` in save-confirmation paths with `sendSystemReply(message, text, "ok")`
- [ ] Replace `message.reply(text)` in save-failure paths with `sendSystemReply(message, text, "error")`
- [ ] Replace `message.reply(text)` in unsafe-filename paths with `sendSystemReply(message, text, "error")`
- [ ] Replace `message.reply(text)` in ASR-not-configured path with `sendSystemReply(message, text, "warn")`
- [ ] Replace `message.reply(text)` in no-speech-detected path with `sendSystemReply(message, text, "info")`
- [ ] Replace `message.reply(text)` in no-project-directory paths with `sendSystemReply(message, text, "warn")`
- [ ] Replace `message.reply("Queued. Will run after this turn.")` with `sendSystemReply(message, "Queued. Will run after this turn.", "queued")`
- [ ] Replace `message.reply("Something went wrong. Please try again.")` with `sendSystemReply(message, "Something went wrong. Please try again.", "error")`
- [ ] Replace command dispatch reply: `message.reply(result.reply)` → `sendSystemReply(message, result.reply, result.tag ?? "ok")` (both instant and deferred paths)
- [ ] Strip `❌` emoji from `ModelNotCapableError` replies (2 occurrences at lines 219 and 346) — use `sendSystemReply(message, err.message, "error")`
- [ ] Do NOT touch guest-mode `article()` calls (`⏳` at line 808, `⚠️` at line 812) — they use `answerGuestQuery`, not `message.reply`
- [ ] Verify `recordAssistantReply` calls still log raw text without tag prefix
- [ ] Update `src/tg/intake.test.ts` — add tests asserting correct tags for key paths
- [ ] Run `bun test src/tg/intake.test.ts` — all tests pass
- [ ] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 6: Route grammy-only commands through systemReply

- [ ] Update `src/commands/start.ts` — use `systemReply(text, "info")` and pass result to `ctx.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true`; remove manual `\\.` escaping from source strings
- [ ] Update `src/commands/ping.ts` — use `systemReply(text, "info")` and pass to `ctx.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true`
- [ ] Update `src/commands/start.test.ts` — adjust expected reply format for tag prefix and MarkdownV2
- [ ] Run `bun test src/commands/start.test.ts src/commands/ping.test.ts` — all tests pass
- [ ] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 7: Full verification

- [ ] Run `bun test` — all tests pass
- [ ] Run `bun run --bun tsc --noEmit` — type check passes
- [ ] Manual smoke test: send `/start`, `/new`, `/project ~/build/little-goblin`, a message, `/queue test`, `/cancel` — verify tags render as monospaced `[ok]`/`[info]`/`[queued]` in Telegram, agent markdown renders, system messages don't ping

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

- [x] Add `ReplyOpts` type (`{ parse_mode?: string; disable_notification?: boolean }`) to `src/tg/intake.ts`
- [x] Change `TelegramIntakeMessage.reply` signature to `(text: string, opts?: ReplyOpts) => Promise<void>`
- [x] Update `intakeMessageFromCtx` in `src/bot.ts` — pass `opts` through to `ctx.reply(text, opts)`
- [x] Update `replyNoActiveSession` in `src/bot.ts` — pass `opts` through to `ctx.reply(text, opts)`
- [x] Update `makeMessage` helper in `src/tg/intake.test.ts` — accept and ignore optional `opts` parameter
- [x] Run `bun test` — all existing tests still pass (backward-compatible change)
- [x] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 3: Add MarkdownV2 to MessageBuffer response path

- [x] Add `parse_mode: "MarkdownV2"` to response `sendMessage` and `editMessageText` via `this.withThread({ parse_mode: "MarkdownV2" })` in `flushResponse` (response path only, not status)
- [x] Add `stripMdV2` import to `buffer.ts`
- [x] Add `responseIsPlainText: boolean` field to `MessageBuffer`, initialized `false`
- [x] Add 400 parse-error detection in the response flush `catch` block — before `handleResponseError`, check for 400 + "parse"/"markdown" in description; if so, call `stripMdV2(text)`, retry with `this.withThread()` (no parse_mode), set `responseIsPlainText = true`; if retry fails, call `handleResponseError` on the retry error
- [x] Skip MarkdownV2 (use plain `this.withThread()`) when `responseIsPlainText` is true
- [x] Reset `responseIsPlainText = false` wherever `responseMessageId` is cleared (tool boundary seal, rollover, file escape)
- [x] Add `{ parse_mode: "MarkdownV2" }` to `maybeRollover` head sends and `maybeFileEscape` summary send
- [x] Add inline-code-span safety check in `maybeRollover` — if split point has odd unescaped backtick count, move split backward to before the last backtick
- [x] Add tests in `src/tg/buffer.test.ts` for MarkdownV2 parse mode on response sends
- [x] Add test for 400 parse-error → plain-text fallback with sticky flag (subsequent edits skip MarkdownV2)
- [x] Add test for sticky flag reset on tool boundary seal
- [x] Add test for rollover split avoiding inline code span break
- [x] Verify status-line `sendMessage`/`editMessageText` calls remain plain text (no `parse_mode`) — add test asserting status sends do not include `parse_mode`
- [x] Run `bun test src/tg/buffer.test.ts` — all tests pass
- [x] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 4: Add tag to DispatchResult and update command handlers

- [x] Import `SystemTag` type in `src/commands/registry.ts`
- [x] Add optional `tag?: SystemTag` to the `replied` variant of `DispatchResult`
- [x] Update `replied()` helper to accept optional `tag` parameter
- [x] Set `tag: "error"` on all "Failed to ..." error replies in command handlers (new, archive, project, model, think, compact, name, resume, subagents, schedule)
- [x] Set `tag: "info"` on usage replies and "No active session" replies in command handlers
- [x] Set `tag: "queued"` on queue ack when streaming, `"ok"` when idle in `queueHandler`
- [x] Set `tag: "warn"` on config-issue replies (e.g. think command "Unknown level", model "No favorites configured")
- [x] Set `tag: "error"` on voice failure replies
- [x] Update `src/commands/registry.test.ts` — test `tag` field propagation
- [x] Run `bun test src/commands/` — all command tests pass
- [x] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 5: Wire intake system replies through sendSystemReply

- [x] Import `sendSystemReply` in `src/tg/intake.ts`
- [x] Replace `message.reply(text)` in `replyNoActiveSession` with `sendSystemReply(message, text, "info")`
- [x] Replace `message.reply(text)` in download-failure paths with `sendSystemReply(message, text, "error")`
- [x] Replace `message.reply(text)` in save-confirmation paths with `sendSystemReply(message, text, "ok")`
- [x] Replace `message.reply(text)` in save-failure paths with `sendSystemReply(message, text, "error")`
- [x] Replace `message.reply(text)` in unsafe-filename paths with `sendSystemReply(message, text, "error")`
- [x] Replace `message.reply(text)` in ASR-not-configured path with `sendSystemReply(message, text, "warn")`
- [x] Replace `message.reply(text)` in no-speech-detected path with `sendSystemReply(message, text, "info")`
- [x] Replace `message.reply(text)` in no-project-directory paths with `sendSystemReply(message, text, "warn")`
- [x] Replace `message.reply("Queued. Will run after this turn.")` with `sendSystemReply(message, "Queued. Will run after this turn.", "queued")`
- [x] Replace `message.reply("Something went wrong. Please try again.")` with `sendSystemReply(message, "Something went wrong. Please try again.", "error")`
- [x] Replace command dispatch reply: `message.reply(result.reply)` → `sendSystemReply(message, result.reply, result.tag ?? "ok")` (both instant and deferred paths)
- [x] Strip `❌` emoji from `ModelNotCapableError` replies (2 occurrences at lines 219 and 346) — use `sendSystemReply(message, err.message, "error")`
- [x] Do NOT touch guest-mode `article()` calls (`⏳` at line 808, `⚠️` at line 812) — they use `answerGuestQuery`, not `message.reply`
- [x] Verify `recordAssistantReply` calls still log raw text without tag prefix
- [x] Update `src/tg/intake.test.ts` — add tests asserting correct tags for key paths
- [x] Run `bun test src/tg/intake.test.ts` — all tests pass
- [x] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 6: Route grammy-only commands through systemReply

- [x] Update `src/commands/start.ts` — use `systemReply(text, "info")` and pass result to `ctx.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true`; remove manual `\\.` escaping from source strings
- [x] Update `src/commands/ping.ts` — use `systemReply(text, "info")` and pass to `ctx.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true`
- [x] Update `src/commands/start.test.ts` — adjust expected reply format for tag prefix and MarkdownV2
- [x] Run `bun test src/commands/start.test.ts src/commands/ping.test.ts` — all tests pass
- [x] Run `bun run --bun tsc --noEmit` — type check passes

## Phase 7: Full verification

- [x] Run `bun test` — all tests pass
- [x] Run `bun run --bun tsc --noEmit` — type check passes
- [x] Manual smoke test: send `/start`, `/new`, `/project ~/build/little-goblin`, a message, `/queue test`, `/cancel` — verify tags render as monospaced `[ok]`/`[info]`/`[queued]` in Telegram, agent markdown renders, system messages don't ping

# reply-formatting — Design

## Architecture

The change adds a formatting layer between command/intake logic and Telegram sends. Today every system reply goes through `message.reply(text)` (a `(text: string) => Promise<void>` wrapper around `ctx.reply(text)`), and every agent response goes through `MessageBuffer`'s `sendMessage`/`editMessageText` calls — all plain text, no `parse_mode`.

After the change:

```
Command handler → DispatchResult { reply, tag } → intake dispatch
                                                        ↓
                                                  sendSystemReply(message, text, tag)
                                                        ↓
                                                  format.ts: systemReply(text, tag)
                                                        ↓
                                                  message.reply(formatted, { parse_mode, disable_notification })

Agent text delta → MessageBuffer.flushResponse
                        ↓
                  sendMessage/editMessageText with parse_mode: "MarkdownV2"
                        ↓
                  on 400 → strip markdown → retry as plain text
```

The formatting layer is a single new module (`src/tg/format.ts`) with three exports: `escapeMdV2`, `systemReply`, `sendSystemReply`. The buffer change is localized to the response flush path in `MessageBuffer`. The intake change replaces `message.reply(text)` calls with `sendSystemReply(message, text, tag)`.

## Decisions

### D1: Extend `TelegramIntakeMessage.reply` to accept send options

**Chosen:** Add an optional second parameter `opts?: { parse_mode?: string; disable_notification?: boolean }` to the `reply` method on `TelegramIntakeMessage`. The `intakeMessageFromCtx` factory in `bot.ts` passes these through to `ctx.reply(text, opts)`.

**Why over alternatives:**
- *Alternative: `sendSystemReply` calls `bot.api.sendMessage` directly.* Rejected — it would bypass the `ctx.reply` path, losing grammy's reply-to-message threading and topic routing that `ctx.reply` handles. The intake message abstraction exists precisely to keep intake logic decoupled from grammy `Context`; threading options through it preserves that.
- *Alternative: Make `sendSystemReply` take a `Bot` and `chatId`.* Rejected — same problem, plus it would need to duplicate the thread/topic routing logic that `ctx.reply` already handles.

**Constraints:** The `reply` signature change is backward-compatible — existing callers that pass only `text` still work. The test helper `makeMessage` in `intake.test.ts` needs to accept (and ignore) the second parameter.

### D2: MarkdownV2 for both agent replies and system messages

**Chosen:** Use `parse_mode: "MarkdownV2"` for both agent response sends and system reply sends. One parse mode, one escaping helper.

**Why over alternatives:**
- *Alternative: HTML for system messages, MarkdownV2 for agent replies.* Rejected — two parse modes means two escaping strategies. MarkdownV2's escaping is already needed for agent replies; using it for system messages too means one code path. HTML would be more forgiving for system messages (no need to escape `.` `!` `-`), but the added complexity of two escapers isn't worth it for ~100 short reply strings.
- *Alternative: HTML for everything.* Rejected — the model emits markdown natively. Converting model markdown to HTML on every turn is fragile and lossy. MarkdownV2 renders model markdown directly.

**Constraints:** MarkdownV2 requires escaping `._*[]()~`>#+-=|{}.!\\` outside code spans. The `escapeMdV2` helper handles this. The model's output is not pre-escaped — it may contain unescaped special characters that cause 400s. The plain-text fallback on 400 handles this.

### D3: Plain-text fallback strips markdown, doesn't retry with HTML

**Chosen:** On 400 from a MarkdownV2 send, strip markdown formatting markers (`*bold*`, `_italic_`, `` `code` ``, `~strike~`, `||spoiler||`, escape backslashes) and retry as plain text (no `parse_mode`). Once a message falls back to plain text, a `responseIsPlainText` flag is set for that message; all subsequent edits to the same message skip MarkdownV2 entirely. The flag resets when a new response message is created (tool boundary seal, rollover, `onAgentEnd`).

**Why over alternatives:**
- *Alternative: Retry with HTML parse mode.* Rejected — the same unescaped characters that break MarkdownV2 would need HTML escaping, and the conversion from MarkdownV2 to HTML is non-trivial. Plain text is the reliable fallback.
- *Alternative: Don't retry, just log and drop.* Rejected for agent replies — losing the agent's response entirely is worse than showing it without formatting. For system replies, dropping is acceptable (the helper logs and swallows), but for agent replies the buffer must retry.
- *Alternative: Retry MarkdownV2 on every edit (no sticky flag).* Rejected — if the model emits malformed markdown, every subsequent edit as more tokens arrive would fail MarkdownV2 and retry, doubling API calls on every flush. The sticky flag ensures one fallback per message, not one per edit.

**Constraints:** The strip function (`stripMdV2` in `format.ts`) must handle the case where the model emitted partial or malformed markdown. It removes formatting markers but preserves the readable text. This is the same pattern Hermes uses (`_strip_mdv2` in its Telegram adapter). The sticky flag adds one boolean field to `MessageBuffer` and is reset in the same places `responseMessageId` is cleared (seal, rollover, file escape).

### D4: Tag prefix in backticks, not blockquotes or HTML

**Chosen:** System messages are prefixed with `` `[tag]` `` (backtick-wrapped tag in MarkdownV2), producing a monospaced `[ok]` / `[error]` / etc. in Telegram.

**Why over alternatives:**
- *Alternative: Telegram blockquotes (`> text`).* Rejected — blockquotes in MarkdownV2 require escaping `>` and produce a gray-bar style that's visually heavy for short acks. The tag prefix is lighter and more flexible.
- *Alternative: HTML `<blockquote>`.* Rejected — would require HTML parse mode for system messages, adding a second escaping strategy (D2).
- *Alternative: Emoji prefixes.* Rejected per user preference — ASCII tags in monospaced backticks are cleaner.

**Constraints:** The backtick-wrapped tag renders as monospaced text in Telegram. The tag itself (`ok`, `error`, `warn`, `info`, `queued`) is always ASCII-safe — no escaping needed inside the backticks. The text after the tag IS escaped via `escapeMdV2`.

### D5: `DispatchResult.tag` is optional, defaults to `"ok"`

**Chosen:** Add `tag?: SystemTag` to the `replied` variant of `DispatchResult`. Omitting it defaults to `"ok"`. This means existing command handlers that don't set `tag` continue to work — their replies get `[ok]` prefixed, which is correct for most success cases.

**Why over alternatives:**
- *Alternative: Make `tag` required.* Rejected — it would force every existing handler to be edited in one pass. Optional-with-default lets us migrate incrementally and is backward-compatible with existing tests that assert on `DispatchResult` shape.
- *Alternative: Infer tag from reply text content.* Rejected — string-matching ("Failed to..." → error) is fragile and would misclassify edge cases. The command handler knows the semantics; let it say.

**Constraints:** The `replied()` helper in `registry.ts` gains an optional `tag` parameter. Existing calls `replied("some text")` still compile. New calls `replied("Failed.", "error")` or `replied("Usage: ...", "info")` set the tag explicitly.

### D6: `disable_notification: true` for all system messages

**Chosen:** All system replies send with `disable_notification: true` (silent delivery). Agent replies notify normally (no `disable_notification`).

**Why:** System messages are operational acks (queued, saved, bound, failed) — they don't warrant a push notification. The agent's actual response is what the user is waiting for. This matches Hermes' "important" notification mode default.

**Constraints:** The `sendSystemReply` helper accepts `opts.silent` (default `true`). Setting `silent: false` sends with notification. No existing system reply needs non-silent delivery today.

### D7: Status line unchanged

**Chosen:** The `MessageBuffer` status line (🤔 thinking, 🔧 bash, ✅ read) keeps its current format and plain-text sends. No `parse_mode` on status sends.

**Why:** The status line already has its own visual identity (emoji slots, its own message). Adding MarkdownV2 to status sends would require escaping every slot label and would gain nothing — the emoji are already plain-text-safe and the tool names are simple identifiers. The status line is not a "system reply" in the same sense as command results.

## File Changes

### New files

**`src/tg/format.ts`** — The formatting module.
- `escapeMdV2(text: string): string` — escapes MarkdownV2-special chars outside code spans and fenced blocks.
- `stripMdV2(text: string): string` — removes MarkdownV2 formatting markers for plain-text fallback.
- `systemReply(text: string, tag: SystemTag): string` — wraps text as `` `[tag]` `` + escaped text.
- `sendSystemReply(message, text, tag, opts?)` — formats + sends via `message.reply` with `parse_mode` and `disable_notification`, with plain-text fallback on 400.
- `type SystemTag = "ok" | "error" | "warn" | "info" | "queued"`.
- Satisfies: "MarkdownV2 escape helper", "System reply formatter", "sendSystemReply helper".

**`src/tg/format.test.ts`** — Colocated tests for the formatting module.
- Tests for `escapeMdV2` (plain text, code spans, fenced blocks, edge cases).
- Tests for `systemReply` (each tag, escaping behavior).
- Tests for `sendSystemReply` (silent flag, parse error fallback, swallow on retry failure).

### Modified files

**`src/tg/intake.ts`** — Replace `message.reply(text)` with `sendSystemReply`.
- `TelegramIntakeMessage.reply` signature changes to `(text: string, opts?: ReplyOpts) => Promise<void>` where `ReplyOpts = { parse_mode?: string; disable_notification?: boolean }`.
- `replyNoActiveSession` (the `intake.ts` implementation at line 164): replace `message.reply("No active session. Use /new to start one.")` with `sendSystemReply(message, "No active session. Use /new to start one.", "info")`. This is the actual send site; the `bot.ts` wrapper just constructs the `TelegramIntakeMessage` and delegates here.
- ~20 other `message.reply(text)` calls replaced with `sendSystemReply(message, text, tag)` where tag is determined by context:
  - Download failures → `"error"`
  - Save confirmations → `"ok"`
  - Save failures → `"error"`
  - Unsafe filename → `"error"`
  - ASR not configured → `"warn"`
  - No speech detected → `"info"`
  - No project directory → `"warn"`
  - Queue ack → `"queued"`
  - Command crash ack ("Something went wrong") → `"error"`
  - `❌ ${err.message}` (ModelNotCapable) → `"error"` (strip the `❌`)
- `recordAssistantReply` calls continue to log raw text (without tag prefix).
- Satisfies: "Intake system replies use tagged formatting", "Command dispatch reply uses tagged formatting".

**`src/tg/buffer.ts`** — Add MarkdownV2 to response path.
- `withThread(opts)` already accepts and spreads an opts parameter, so response sends use `this.withThread({ parse_mode: "MarkdownV2" })` while status sends keep `this.withThread()` (no parse_mode). No new helper needed.
- `flushResponse`: `sendMessage` and `editMessageText` calls in the response path pass `{ parse_mode: "MarkdownV2" }` to `withThread`. When `responseIsPlainText` is true (after a prior fallback), they omit `parse_mode`.
- Parse-error retry: in the `catch` block of the response flush, before calling `handleResponseError`, check if the error is a 400 with "parse" or "markdown" in the description. If so, call `stripMdV2(text)`, retry the send/edit with `this.withThread()` (no parse_mode), and set `responseIsPlainText = true`. If the retry also fails, call `handleResponseError` on the retry error.
- New field: `private responseIsPlainText = false`. Reset to `false` wherever `responseMessageId` is cleared (tool boundary seal in `onToolStart`, rollover in `maybeRollover`, file escape in `maybeFileEscape`).
- `maybeRollover`: `editMessageText` and `sendMessage` for head chunks pass `{ parse_mode: "MarkdownV2" }` to `withThread` (unless `responseIsPlainText`). Split-boundary check for unpaired backticks (odd backtick count → move split backward).
- `maybeFileEscape`: summary `sendMessage` passes `{ parse_mode: "MarkdownV2" }` to `withThread`.
- Status line sends (placeholder, edits) are unchanged — no `parse_mode`.
- Satisfies: "Response text streams via edits" (modified), "Big output escapes to file attachment" (modified), "Plain-text fallback is sticky per message" (added).

**`src/commands/registry.ts`** — Add `tag` to `DispatchResult`.
- `DispatchResult` `replied` variant: `{ kind: "replied"; reply: string; sideEffects: SideEffect[]; tag?: SystemTag }`.
- `replied()` helper: gains optional `tag` parameter: `replied(reply, sideEffects?, tag?)`.
- Import `SystemTag` type from `src/tg/format.ts`.
- Error handlers in command wrappers set `tag: "error"` on their "Failed to..." replies.
- `queueHandler`: ack reply sets `tag: "queued"` when streaming, `"ok"` when idle.
- Usage replies set `tag: "info"`.
- Satisfies: "Command dispatch is Telegram-side-effect-free" (modified), "Queue command enqueues text for the next idle turn" (modified).

**`src/commands/registry.ts`** (continued) — Strip emoji from reply strings.
- The `❌` prefix on `ModelNotCapableError` reply (`❌ ${err.message}`) → `${err.message}` (tag handles the visual distinction).
- Satisfies: "Command handlers strip legacy emoji prefixes".

**`src/tg/intake.ts`** (continued) — Strip `❌` emoji from intake reply strings.
- `❌ ${err.message}` → `${err.message}` (2 occurrences for ModelNotCapable, lines 219 and 346). The `[error]` tag replaces the emoji.
- Guest-mode `article()` calls (`⏳` at line 808, `⚠️` at line 812) are NOT touched — they use `answerGuestQuery`, not `message.reply`.
- Satisfies: "Command handlers strip legacy emoji prefixes".

**`src/bot.ts`** — Update `intakeMessageFromCtx` and `replyNoActiveSession` wrapper.
- `intakeMessageFromCtx`: `reply` wrapper passes `opts` through to `ctx.reply(text, opts)`.
- `replyNoActiveSession` (the `bot.ts` wrapper at line 58): the `reply` lambda inside the constructed `TelegramIntakeMessage` passes `opts` through to `ctx.reply(text, opts)`. This wrapper constructs a `TelegramIntakeMessage` and delegates to `replyNoActiveSession` in `intake.ts` — it does NOT send replies itself. The actual `sendSystemReply` call happens in the `intake.ts` implementation (see below).
- Satisfies: "Intake system replies use tagged formatting" (enabling change — the `opts` pass-through is what allows `sendSystemReply` to set `parse_mode` and `disable_notification` through the `TelegramIntakeMessage.reply` interface).

**`src/commands/start.ts`** — Route through `sendSystemReply`.
- Currently uses `ctx.reply(text, { parse_mode: "MarkdownV2", ...replyOpts })` with manual escaping.
- Replace with `sendSystemReply`-equivalent for the grammy path. Since `/start` uses `ctx.reply` directly (not `TelegramIntakeMessage.reply`), either:
  - (a) Construct a `TelegramIntakeMessage` from ctx and call `sendSystemReply`, or
  - (b) Call `systemReply(text, "info")` and pass the result to `ctx.reply(formatted, { parse_mode: "MarkdownV2", disable_notification: true, ...replyOpts })`.
- Option (b) is simpler — no need to construct a full `TelegramIntakeMessage` for a grammy-only handler. The manual escaping in the existing strings (`\\.`) is removed since `systemReply` handles escaping.
- Satisfies: "Grammy-only commands use tagged formatting".

**`src/commands/ping.ts`** — Route through `systemReply`.
- Same pattern as `start.ts`: call `systemReply(text, "info")` and pass to `ctx.reply` with `parse_mode` and `disable_notification`.
- Satisfies: "Grammy-only commands use tagged formatting".

**`src/tg/mod.ts`** — Export `sendSystemReply`, `systemReply`, `escapeMdV2`, `SystemTag` from the tg barrel.

### Test files

**`src/tg/intake.test.ts`** — Update `makeMessage` helper.
- `reply` mock accepts optional second `opts` parameter (ignored for most tests).
- Add tests asserting `sendSystemReply` is called with correct tags for key paths (download failure → error, save → ok, queue → queued).

**`src/tg/buffer.test.ts`** — Add MarkdownV2 tests.
- Test that response `sendMessage` includes `parse_mode: "MarkdownV2"`.
- Test 400 parse error → plain-text retry with stripped markdown.
- Test rollover split avoids breaking inline code spans.

**`src/commands/registry.test.ts`** — Add `tag` tests.
- Test that `replied("text", [], "error")` produces `{ kind: "replied", reply: "text", sideEffects: [], tag: "error" }`.
- Test that `replied("text")` produces `tag: undefined` (defaults to `"ok"` at the dispatch site).

## Migration notes

- The `TelegramIntakeMessage.reply` signature change is backward-compatible at the TypeScript level (optional second parameter). Existing test mocks that ignore the second parameter still compile.
- The `DispatchResult` `tag` field is optional. Existing tests that assert on `DispatchResult` shape with `{ kind: "replied", reply, sideEffects }` still pass — the `tag` field is absent, which defaults to `"ok"` at the dispatch site.
- The `start.ts` manual MarkdownV2 escaping (`Welcome back\\. Session`) is removed — `systemReply` handles escaping. The source strings become plain text: `Welcome back. Session ${existing.id} is active. Use /new for a fresh one.`

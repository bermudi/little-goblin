# Tasks: telegram-text-coalescing

## Phase 1: Coalescer module with colocated tests

- [x] Create `src/tg/coalesce.ts` defining the constants `TEXT_SPLIT_THRESHOLD = 4000`, `TEXT_SPLIT_WINDOW_MS = 1200`, `MAX_FRAGMENTS = 12`, `MAX_TOTAL_CHARS = 50_000`, the `CoalesceKey` interface (`{ chatId, topicId, fromUserId }`), and the `BufferEntry` shape: `{ message: TelegramIntakeMessage; text: string; lastMessageId: number; fragmentCount: number; totalChars: number; timer: ReturnType<typeof setTimeout> }`. `message` holds the **first fragment's** `TelegramIntakeMessage`, set at open time and carried on flush (D9).
- [x] Implement `TextCoalescer` with a `submit(input)` method and an injectable `dispatch` callback (so tests pass a fake `dispatch` instead of the real `intake.handleText`). Wire the dispatch callback through the constructor (`new TextCoalescer({ dispatch })`).
- [x] Implement the pass-through path: short text (< 4000) with no open buffer for the key calls `dispatch(message, text)` synchronously (no `setTimeout`).
- [x] Implement the open-buffer path: text ≥ 4000 with no open buffer stores a `BufferEntry` (capturing `input.message` as the retained first-fragment message) and starts a `TEXT_SPLIT_WINDOW_MS` trailing debounce timer that flushes on elapse.
- [x] Implement the append path: a fragment is appended when a buffer is open for the key AND `messageId === lastBufferedId + 1` AND within the window; the timer is cleared and restarted, and only `text`/`lastMessageId`/`fragmentCount`/`totalChars` are updated (the retained `message` is never overwritten). Otherwise flush-then-handle (flush the pending buffer, then evaluate the incoming message as if fresh). Non-monotonic ids (`messageId <= lastBufferedId`) count as non-adjacent — flush the pending buffer, then evaluate the incoming as fresh.
- [x] Implement flush: concatenate buffered text with no separator, call `dispatch(entry.message, concatenatedText)` using the retained first-fragment `message`, delete the `BufferEntry`, clear the timer.
- [x] Implement the hard-cap guards: reaching `MAX_FRAGMENTS` or `MAX_TOTAL_CHARS` triggers an immediate flush before appending further text; after either flush, the incoming fragment is re-evaluated as fresh — a ≥4000-char fragment opens a new buffer, a short one dispatches immediately.
- [x] Create `src/tg/coalesce.test.ts` with `bun:test` fake timers covering: open-on-threshold, append-on-adjacency, flush-on-timeout, flush-on-non-adjacent, short-pass-through, short-appends-to-open-buffer, fragment-cap (with 13th-fragment re-evaluated as fresh), char-cap (with overflow fragment re-evaluated as fresh), out-of-order-or-duplicate-message_id (flushes pending then handles fresh), command-flush, multi-sender-isolation, multi-topic-isolation. Each test asserts `dispatch` was called with the expected concatenated text and count, and that the first fragment's `message` was the one passed on flush.

Verification: `bun test src/tg/coalesce.test.ts` passes; `bunx tsc --noEmit` is clean.

## Phase 2: Command-flush and bot.ts wiring

- [ ] Add command detection to the coalescer's `submit`: when `input.isCommand` is true, flush any open buffer for the key (in arrival order — buffered text first), then `dispatch` the command immediately. A command never opens a buffer. Add a test: command-with-pending-buffer flushes-then-dispatches in order; command-with-no-buffer dispatches immediately.
- [ ] Export `TextCoalescer` and the constants/types from `src/tg/mod.ts` (barrel), mirroring the existing export pattern.
- [ ] In `src/bot.ts` `buildBot`: construct a single `TextCoalescer` instance after `intake` is created, passing `dispatch: (msg, text) => intake.handleText(msg, text)`.
- [ ] Rewrite the `bot.on("message:text")` handler (`bot.ts:103-105`) to build the `TelegramIntakeMessage` once, extract `fromUserId` from `ctx.from?.id`, `messageId` from `ctx.msg?.message_id`, detect `isCommand` from the first entity (`ctx.msg?.entities?.[0]?.type === "bot_command"`), and call `coalescer.submit({ message, text, key, messageId, isCommand })` instead of calling `intake.handleText` directly.
- [ ] Confirm no other `bot.on(...)` handler changed (media paths must still bypass the coalescer) — diff-verify during review.

Verification: `bun test` (full suite) passes; `bunx tsc --noEmit` is clean; the existing `src/bot.ts`-adjacent tests (if any) still pass. Manual smoke check: a short DM message still responds with no added latency; a paste over 4096 chars arrives as a single agent turn.

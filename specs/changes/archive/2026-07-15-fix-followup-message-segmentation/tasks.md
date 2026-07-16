## Phase 1: Add message boundary callbacks to agent dispatch

- [x] Add `onMessageStart` and `onMessageEnd` to `TurnCallbacks` in `src/agent/events.ts`.
- [x] Update `dispatchAgentEvent` to emit `onMessageStart`/`onMessageEnd` for assistant `message_start`/`message_end` events.
- [x] Add `onMessageStart`/`onMessageEnd` no-ops to `GuestReplySink` in `src/tg/guest-sink.ts`.
- [x] Run `bun test` to ensure existing tests still compile.

## Phase 2: Segment MessageBuffer response messages on assistant boundaries

- [x] Implement `onMessageStart` in `MessageBuffer` to force-flush and reset response state (`responseMessageId`, `accumulatedText`, `lastRenderedResponseText`, `responseIsPlainText`).
- [x] Implement `onMessageEnd` in `MessageBuffer` to force-flush the current response message without resetting state.
- [x] Add tests for two assistant messages in one turn producing two Telegram bubbles, and for no stub on the first assistant message.
- [x] Run `bun test` and fix any failures.

## Phase 3: Update canon specs

- [x] Apply the delta specs for `agent` and `message-buffer` when the implementation is accepted.
- [x] Archive the change with `litespec archive fix-followup-message-segmentation`.

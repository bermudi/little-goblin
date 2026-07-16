## Architecture

`AgentRunner` already receives every `AgentSessionEvent` in `handleEvent` and passes each event to `dispatchAgentEvent(event, callbacks)`. The `TurnCallbacks` interface is the boundary between the agent layer and the Telegram layer. Adding `onMessageStart` and `onMessageEnd` to that interface lets `MessageBuffer` know when one assistant message ends and another begins, so it can seal the current Telegram bubble and start a new one.

`pi-agent-core` emits `message_start` and `message_end` events for every message (user, assistant, toolResult). The dispatch function filters by `message.role === "assistant"` so only assistant message boundaries reach the buffer.

`MessageBuffer` already knows how to seal a response segment at a tool boundary (`onToolStart` flushes and resets `responseMessageId`, `accumulatedText`, `lastRenderedResponseText`, and `responseIsPlainText`). The same seal logic is reused for an assistant `message_start` boundary. The `onMessageEnd` callback is a lighter final-flush signal; `onMessageStart` is the primary seal trigger because it marks the beginning of a new assistant message.

## Decisions

### Use `message_start` as the primary seal trigger

`onMessageEnd` could flush but cannot safely reset `responseMessageId` until the next assistant message begins, because `message_end` for the first assistant message is followed by a user message and then a second assistant message. Resetting at `message_start` ensures the new assistant message starts a fresh Telegram bubble without losing the last edit of the previous message.

### Extend `TurnCallbacks` rather than adding a side channel

`MessageBuffer` is passed to `AgentRunner.prompt()` as `callbacks`. The cleanest way to give it boundary information is to add methods to `TurnCallbacks`. This keeps all rendering concerns in the Telegram layer and avoids leaking `MessageBuffer` state back into `AgentRunner`.

### No change to `/voice` tool

`/voice` currently reads the last assistant message (or the runner's last per-message text). Once `MessageBuffer` produces separate Telegram bubbles, the transcript is still the same but the user-visible Telegram messages are split. The `/voice` tool is not in scope; if it still consumes the wrong segment, it is a separate bug.

## File Changes

- `src/agent/events.ts`
  - Add `onMessageStart(message?: AgentMessage)` and `onMessageEnd(message?: AgentMessage)` to the `TurnCallbacks` interface.
  - Update `dispatchAgentEvent` to handle `message_start` and `message_end` events for `message.role === "assistant"`.
  - Keep the existing `message_end` assistant error handling (emit `\n\n❌ <label>: <errorMessage>`) after `onMessageEnd`.

- `src/agent/mod.ts`
  - Re-export `TurnCallbacks` unchanged (it already re-exports from `events.ts`).

- `src/tg/buffer.ts`
  - Add `onMessageStart()` and `onMessageEnd()` to `MessageBuffer`.
  - `onMessageStart()` seals the current response message (if any) and resets response state so the next `onTextDelta` creates a new Telegram message.
  - `onMessageEnd()` force-flushes the current response message (if any) but does not reset state, unless it is combined with `onMessageStart` for the next message.

- `src/tg/guest-sink.ts`
  - Add `onMessageStart()` and `onMessageEnd()` as no-ops so it continues to satisfy `TurnCallbacks` and accumulate all text into `.text`.

- `specs/canon/agent/spec.md`
  - Modify `TurnCallbacks interface defined in agent/events.ts` to include `onMessageStart` and `onMessageEnd`.
  - Modify `Shared event dispatch function in agent/events.ts` to include `message_start` and `message_end` handling.

- `specs/canon/message-buffer/spec.md`
  - Modify `MessageBuffer implements TurnCallbacks interface` to include the two new methods.
  - Modify `Response message segments at tool boundaries` to include assistant message boundaries as another seal trigger.
  - Add `Response message segments at assistant message boundaries` requirement.

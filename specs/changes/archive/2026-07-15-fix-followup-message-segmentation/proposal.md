## Motivation

When a second user message arrives while goblin is already streaming, the intake layer routes it through `AgentRunner.followUp()`. pi-agent-core queues it as a follow-up and, after the current assistant turn finishes, runs another turn. The model therefore produces two separate assistant messages (one for the first user message, one for the second). Goblin's `MessageBuffer` currently appends the second assistant response to the same Telegram message as the first, producing a single bolted-together reply with no separator. This breaks the conversational UX and causes tools like `/voice` to consume only the last assistant message while the Telegram message contains both.

## Scope

- Extend the `TurnCallbacks` interface in `src/agent/events.ts` with `onMessageStart()` and `onMessageEnd()` callbacks.
- Update `dispatchAgentEvent` in `src/agent/events.ts` to emit `onMessageStart` and `onMessageEnd` for assistant `message_start` / `message_end` events.
- Update `MessageBuffer` in `src/tg/buffer.ts` to seal the current response message and start a new Telegram bubble on an assistant `message_start` boundary. `message_end` may force-flush the current segment; `message_start` is the primary boundary signal.
- Update `GuestReplySink` to implement the new callbacks as no-ops (guest replies still accumulate all text).
- Update the canon specs for `agent` and `message-buffer` to describe the new behavior.

## Non-Goals

- This change does not alter the steer/follow-up dispatch policy. The intake layer still routes mid-flight messages to `runner.followUp()`.
- It does not change transcript, memory reflection, or `AgentRunner` event handling beyond the `TurnCallbacks` additions.
- It does not add a per-message `voice` or `/voice` tool rework; it only fixes the message segmentation that exposed the `/voice` symptom.

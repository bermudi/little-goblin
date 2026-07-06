# telegram

## ADDED Requirements

### Requirement: Allowlist middleware gates guest_message updates by summoner

The allowlist middleware SHALL recognize `guest_message` updates and apply the same `cfg.allowedTgUserIds` membership check used for DMs, keyed on `guest_message.from.id` (the summoner, not the chat). Because grammy does not populate `ctx.chat`/`ctx.from` for `guest_message`, the middleware SHALL read the summoner id directly from `ctx.update.guest_message.from.id`. BotFather's "Restrict bot usage" setting does NOT gate `guest_message`, so this code-level check is load-bearing — without it, any user who knows the bot's username can summon it and burn LLM credits.

#### Scenario: Guest summon from allowed user

- **WHEN** a `guest_message` update arrives
- **AND** `guest_message.from.id` is in `cfg.allowedTgUserIds`
- **THEN** the middleware SHALL call `next()`

#### Scenario: Guest summon from non-allowed user

- **WHEN** a `guest_message` update arrives
- **AND** `guest_message.from.id` is NOT in `cfg.allowedTgUserIds`
- **THEN** the middleware SHALL NOT call `next()`
- **AND** SHALL NOT reply
- **AND** SHALL emit a debug log with the summoner's user id and username

#### Scenario: guest_query_id never enters logs

- **WHEN** the middleware logs anything about a `guest_message` update (allowed or dropped)
- **THEN** the log payload SHALL NOT include the `guest_query_id` field
- **AND** SHALL NOT include a raw JSON dump of the update

#### Scenario: Diagnostic update-shape log is removed

- **WHEN** the change is complete
- **THEN** the temporary diagnostic `update seen` / `GUEST update` log statements added during investigation SHALL be removed from `src/tg/middleware.ts`

### Requirement: Guest message intake runs the agent to completion and replies once

The intake module SHALL provide a `handleGuestMessage(message, text)` method that resolves (or auto-creates) a guest session keyed on the foreign `chat.id`, runs the agent to completion against a non-streaming sink, and sends exactly one reply via the `message.replyVia` callback. The reply SHALL be a single `InlineQueryResultArticle` wrapping `InputTextMessageContent(message_text = <full accumulated assistant text>)`. The handler SHALL NOT use `MessageBuffer`'s streaming-edit path, because `answerGuestQuery` accepts one short-lived single-use call per `guest_query_id`.

The `message` argument SHALL carry `{ chatId: number; replyVia: (result: InlineQueryResult) => Promise<unknown> }`. The `replyVia` callback encapsulates the `answerGuestQuery` call (the `bot.ts` adapter constructs it as `(result) => ctx.answerGuestQuery(result)`, so grammy auto-reads `guest_query_id` from `ctx.guestMessage`). The intake module SHALL NOT extract, name, log, or persist `guest_query_id` — it lives entirely inside the `replyVia` closure and SHALL NOT be written to session state, transcript, logs, or model context.

The `text` argument SHALL already have the `@botname` mention stripped and a sender prefix applied by the `bot.ts` adapter (the intake does not import grammy's `Context`, so it cannot call `stripBotMention`/`prepareUserContent` itself).

If the agent turn produces no text (empty accumulation), the handler SHALL reply with a short fixed fallback message (e.g. `(no response)`) so the summoner sees the bot acknowledged the mention, rather than silence.

If the runner is already streaming when `handleGuestMessage` is invoked, the intake SHALL NOT queue the turn (the `guest_query_id` would expire before a queued turn runs). It SHALL reply immediately via `replyVia` with a short "busy" fallback so the summoner receives an acknowledgment and `guest_query_id` is consumed before it expires.

If `replyVia` itself rejects (e.g. expired `guest_query_id`), the intake SHALL log a warning and swallow the rejection — the summoner sees nothing, but the bot does not crash. This is an inherent limitation of the one-shot API.

#### Scenario: Allowed guest text summon produces one answerGuestQuery reply

- **WHEN** `handleGuestMessage` is called for a guest message from an allowed summoner (already passed by the middleware)
- **AND** the agent turn completes with non-empty text
- **THEN** intake SHALL call `replyVia` exactly once
- **AND** the `result` SHALL be an `InlineQueryResultArticle` whose `InputTextMessageContent.message_text` equals the full accumulated assistant text
- **AND** SHALL NOT call `sendMessage` to the foreign `chat.id`

#### Scenario: Empty agent output sends a fallback reply

- **WHEN** `handleGuestMessage` runs the agent to completion
- **AND** the accumulated assistant text is empty
- **THEN** intake SHALL call `replyVia` exactly once with a short fixed fallback message
- **AND** SHALL NOT omit the reply (the summoner MUST see an acknowledgment)

#### Scenario: Busy runner replies with a fallback instead of queueing

- **WHEN** `handleGuestMessage` is invoked for a guest session whose runner is already streaming
- **THEN** intake SHALL NOT enqueue the turn or call `runner.prompt()`
- **AND** SHALL call `replyVia` once with a short busy fallback (so `guest_query_id` is consumed before expiry)

#### Scenario: replyVia rejection is swallowed

- **WHEN** the `replyVia` callback rejects (e.g. expired `guest_query_id`)
- **THEN** intake SHALL log a warning and swallow the rejection
- **AND** SHALL NOT re-throw or crash

#### Scenario: guest_query_id is not persisted

- **WHEN** a guest turn is handled
- **THEN** the intake code SHALL NOT name or extract `guest_query_id` into a variable
- **AND** the id SHALL NOT be written to `state/sessions/<id>/state.json`
- **AND** SHALL NOT be appended to `state/sessions/<id>/transcript.jsonl`
- **AND** SHALL NOT appear in any log payload

#### Scenario: Guest media message is ignored

- **WHEN** a `guest_message` update arrives carrying media (photo, document, voice, audio) and no `text` field (caption-only media counts as "no text" — captions are out of scope)
- **THEN** intake SHALL drop it with a debug log
- **AND** SHALL NOT call `replyVia` or run the agent

### Requirement: buildBot wires a guest_message grammy handler

`buildBot` (`src/bot.ts`) SHALL register `bot.on("guest_message", handler)` (grammy 1.44.0's native filter query for the Bot API 10.0 `guest_message` update type). The handler SHALL read `ctx.guestMessage`, drop media (no `text`) with a debug log, strip the `@botname` mention and prepend a sender prefix via `prepareUserContent(ctx, text)` (the adapter has `ctx`; the intake does not), and call `await intake.handleGuestMessage({ chatId: ctx.guestMessage.chat.id, replyVia: (result) => ctx.answerGuestQuery(result) }, cleanedText)`. The handler SHALL NOT extract `guest_query_id` into a named variable — grammy's `ctx.answerGuestQuery` reads it internally.

#### Scenario: guest_message routed to intake

- **WHEN** a `guest_message` update passes the allowlist middleware
- **THEN** `buildBot`'s guest handler SHALL read `ctx.guestMessage`
- **AND** SHALL strip the `@botname` mention and prepend a sender prefix via `prepareUserContent`
- **AND** SHALL delegate to `intake.handleGuestMessage({ chatId, replyVia }, cleanedText)`

#### Scenario: Non-guest updates do not hit the guest handler

- **WHEN** a regular `message`, `callback_query`, or other non-guest update arrives
- **THEN** the guest handler SHALL NOT fire

### Requirement: Guest session locator keys on the foreign chat id

For guest turns, the intake module SHALL construct a `ChatLocator` whose `chatId` is `guest_message.chat.id` (the foreign chat the bot is not a member of) and whose `topicId` is `undefined`. The locator SHALL be passed to `SessionManager.resolve(loc, { isGuest: true })` so the session layer auto-creates a guest binding on first summon (mirroring topic/supergroup auto-create, NOT DM-style explicit-create).

#### Scenario: Guest locator is the foreign chat id

- **WHEN** `handleGuestMessage` builds a locator for a guest turn
- **THEN** the locator SHALL be `{ chatId: <guest_message.chat.id> }` with no `topicId`

#### Scenario: Guest session auto-creates on first summon

- **WHEN** `handleGuestMessage` resolves a locator for a foreign chat that has no prior guest binding
- **THEN** `SessionManager.resolve(loc, { isGuest: true })` SHALL create and return a new session
- **AND** SHALL NOT require a prior `/new`

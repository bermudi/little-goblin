# telegram-guest-mode

## Motivation

Telegram's Guest Mode (Bot API 10.0) lets a bot be `@mentioned` in chats it is not a member of — a private DM between two other users, or a group it hasn't joined. The owner enables "Guest Mode" in BotFather's MiniApp; thereafter, when someone summons the bot, Telegram delivers a new top-level update type, `guest_message`, to the bot's `getUpdates` poll.

Little-goblin currently does not respond to these summons. Empirical investigation (diagnostic middleware logging every update) confirmed two distinct gaps:

1. **No handler matches `guest_message`.** grammy's `bot.on("message:...")` filter only matches `update.message`, not `update.guest_message`. The update reaches the global allowlist middleware (via `bot.use()`), but because grammy does not populate `ctx.chat`/`ctx.from` for `guest_message` (those are derived from `update.message`), the middleware hits its `if (!ctx.chat || !ctx.from)` early-return and calls `next()`. No downstream handler fires, so the bot is silent.
2. **Guest replies use a different API method.** A guest response is sent via `answerGuestQuery(guest_query_id, result)`, where `result` is an `InlineQueryResult` and the call returns a `SentGuestMessage`. This is fundamentally incompatible with the existing `MessageBuffer` streaming UX, which keys on a `chatId` and streams via throttled `editMessageText` against a sent message id. `answerGuestQuery` accepts one short-lived, single-use call per `guest_query_id`.

A second empirical finding shapes the access design: **BotFather's "Restrict bot usage" setting does NOT gate `guest_message`.** A non-allowlisted account that mentions the bot produces a delivered `guest_message` update. Without a code-level access check, any user who discovers the bot's username can burn LLM credits by spamming mentions.

## Scope

**Affected capabilities:** `telegram`, `sessions`, `message-buffer`.

### What's added

- **`guest_message` recognition in the allowlist middleware** (`src/tg/middleware.ts`). A `guest_message` SHALL be allowed through iff `from.id` is in `cfg.allowedTgUserIds`; otherwise silently dropped with the same debug-log shape used for non-allowed DMs. This is load-bearing: BotFather's restriction does not cover guest updates.
- **A `guest_message` intake path** that runs the agent to completion and replies once via `answerGuestQuery`. No streaming. The path lives alongside `handleText` in the intake module (`src/tg/intake.ts`), wired from a one-line grammy adapter in `src/bot.ts`.
- **A non-streaming reply adapter** so guest turns use a callback-style sink (accumulate the full assistant text, then call `answerGuestQuery` once) rather than `MessageBuffer`'s streaming edits. The existing `MessageBuffer` path is unchanged for normal messages.
- **Session keying for guest turns by the foreign `chat.id`.** Guest sessions SHALL be auto-created on first summon (like topics/supergroups, not like DMs — no `/new` required). Repeat summons from the same foreign chat SHALL share conversation history.

### `guest_query_id` hygiene

`guest_query_id` authorizes exactly one `answerGuestQuery` call and is short-lived. It SHALL NOT be persisted to `state/`, transcript, logs, or model context. It SHALL live in handler scope only, plumbed from the grammy adapter to the reply callback.

### Reply shape

A guest reply SHALL be a single `answerGuestQuery` call with one `InlineQueryResultArticle` wrapping `InputTextMessageContent(message_text = <full assistant text>)`. The reply SHALL NOT stream.

## Non-Goals

- **No streaming for guest replies.** The single-shot `answerGuestQuery` API does not support edit-in-place. Guest turns are "think, then send one complete message."
- **No media handling in guest messages.** Only text summons are in scope. A `guest_message` carrying media (photo/document/voice) SHALL be ignored for now (dropped with a debug log).
- **No re-keying of existing DM/group/topic sessions.** The new guest session binding is a separate binding surface keyed on the foreign `chat.id`. The existing `dm` / `topics` / `supergroups` binding maps are untouched.
- **No per-user isolation within a shared foreign chat.** In a group the bot isn't a member of, every summoner shares one guest session keyed by that group's `chat.id`. This matches the user's stated per-chat-session preference for the DM case (the common case) and is documented as a known wrinkle for groups.
- **No migration of `guest_query_id` into long-lived state.** It is ephemeral by API contract.
- **No new config knob.** Guest access reuses `cfg.allowedTgUserIds`. BotFather's "Guest Mode" toggle remains the platform-side enable; the code-level allowlist is the app-side gate.

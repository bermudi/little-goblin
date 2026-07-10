# telegram-text-coalescing

## Motivation

Telegram clients split text over 4096 characters into multiple `Message` objects before sending. Each fragment arrives as a separate `update` with its own `message_id`, same sender, same second. There is no grouping identifier on text messages (unlike `media_group_id` for photo albums).

Goblin's intake has no coalescing. Each fragment is a separate `bot.on("message:text")` → `intake.handleText()` call. The second fragment's fate depends on a timing race:

- If the first fragment's turn has already started streaming, the second fragment is routed to `runner.followUp()` as a **steering interrupt** (`intake.ts:332`) — mid-turn injection, not a continuation.
- If the runner is still idle, the second fragment is scheduled as an **independent turn** behind the first (`dispatcher.ts:198`).

Either way the full text never reaches the agent as a single unit. The user's logical message is split across a turn and a steer, or across two unrelated turns. This is a data-integrity bug: long messages are silently truncated or semantically scrambled.

Two independent reference implementations (hermes-agent, openclaw) converge on the same fix: detect near-4096 fragments, buffer consecutive fragments from the same sender, flush as a single agent turn. The design is validated prior art, not a novel invention.

## Scope

**Capability affected:** `telegram`.

**New module:** `src/tg/coalesce.ts` — a length-gated text coalescer that sits in front of `intake.handleText`. It:

- Detects fragments at or above a threshold (4000 chars) as likely-split first halves.
- Buffers consecutive fragments from the same `(chatId, topicId, fromUserId)` bucket, requiring **adjacent Telegram `message_id`s** (gap of exactly 1) as a split-corroboration signal.
- Debounces with a trailing window (~1.2s), restarted on each appended fragment.
- Flushes the concatenated text to `intake.handleText` as a single turn.
- Hard-caps the buffer at 12 fragments / 50,000 total chars as a defensive bound.

**Behavior changes:**

- `bot.ts` `message:text` handler builds a coalescer key from `ctx` and routes through the coalescer instead of calling `intake.handleText` directly.
- Short messages (under threshold) pass through with no added latency — they neither enter nor wait on the buffer.
- Slash commands flush any pending buffer immediately, then dispatch without buffering (commands are never coalesced).
- Non-adjacent or out-of-window fragments flush the pending buffer and start fresh; coalescing never silently merges unrelated messages.

**New wiring:** the coalescer is constructed once per `buildBot` call and held as a local variable in `buildBot` alongside `manager`, `runners`, and the dispatcher, shared across all handlers.

## Non-Goals

- **No media coalescing.** Photo bursts and `media_group_id` album handling are out of scope. Media already has its own grouping signals; text does not. This change is text-only.
- **No universal debouncing.** Short rapid-fire messages from the same sender are NOT batched. The steer affordance — where a quick second message mid-turn acts as a redirect — is fully preserved for ordinary messages. Only length-suspected splits enter the buffer.
- **No new config options.** Threshold, window, and caps are module constants, not env vars. Single-user homelab; tuning belongs in a follow-up if a real need arises.
- **No changes to the dispatcher, runner, or agent layer.** The coalescer delivers one `intake.handleText` call per logical message; everything downstream is unchanged.
- **No guest-message coalescing.** Guest turns are one-shot, single-text, and must not queue. The coalescer does not touch `handleGuestMessage`.
- **No scheduled-turn interaction.** Scheduled turns bypass the Telegram intake entirely (`enqueueScheduledTurn`); the coalescer sits only on the `message:text` path.

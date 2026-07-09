# Design: telegram-text-coalescing

## Architecture

The coalescer is a new module at the Telegram layer's edge — the last grammy-facing stop before intake. It wraps `intake.handleText` for the `message:text` path only. Nothing else changes.

```
grammy update
   │
   ▼
allowlist middleware (unchanged)
   │
   ▼
bot.on("message:text", ctx)          ← bot.ts
   │
   ▼
TextCoalescer.submit(ctx)            ← NEW: src/tg/coalesce.ts
   │  (buffers / forwards)
   ▼
intake.handleText(message, text)     ← unchanged
   │
   ▼
TurnDispatcher / AgentRunner         ← unchanged
```

**State.** One `TextCoalescer` instance per `buildBot` call, held in a local in `buildBot` alongside `manager`, `runners`, `subagentRunner`, etc. Its buffer state is a `Map<CoalesceKey, BufferEntry>` where `CoalesceKey = { chatId, topicId, fromUserId }`. Each `BufferEntry` holds: the **first fragment's `TelegramIntakeMessage`** (retained verbatim and passed to `dispatch` on flush — see D9), the concatenated text so far, the last `message_id` seen, a fragment count, a total-char count, and a pending `setTimeout` handle.

**Lifecycle.** The coalescer lives for the bot's lifetime. Buffers are transient — they are created on first fragment and deleted on flush. There is no persistence, no shutdown drain: if the process exits mid-buffer, the in-flight fragment is lost. That is acceptable (the user re-sends) and consistent with how grammy's in-flight update queue behaves on crash.

**Data flow per text update:**

1. `bot.on("message:text")` builds a `TelegramIntakeMessage` via the existing `intakeMessageFromCtx(ctx)` (reused unchanged), extracts `text`, `fromUserId = ctx.from.id`, `messageId = ctx.msg.message_id`, and computes a `CoalesceKey`.
2. It calls `coalescer.submit({ message, text, fromUserId, messageId, key })`.

**Key derivation and nullability.** `CoalesceKey = { chatId, topicId, fromUserId }` is derived from the same `ctx` the handler already uses: `chatId` and `topicId` come from `locatorFromCtx(ctx)` (reused unchanged — it returns `{ chatId, topicId }` with `topicId` undefined outside forum topics), and `fromUserId = ctx.from.id`. `messageId` is `ctx.msg.message_id`. These are non-null by the time the handler runs: the allowlist middleware (`src/tg/middleware.ts:120`) returns early (`await next()`) when `ctx.chat` or `ctx.from` is absent, and Telegram always populates `from` on user-originated messages and `message_id` on `Message` objects. So `CoalesceInput.fromUserId: number` and `messageId: number` are typed non-optional without a null-guard — the precondition is enforced upstream by the middleware. (If `locatorFromCtx` returns null — no valid chat — the handler drops the update before constructing a key, same as it does today.)
3. `submit` decides: pass-through (short, no buffer open), open-buffer (≥4000 chars, no buffer), append (adjacent fragment of an open buffer), or flush-then-handle (command or non-adjacent).
4. On flush, the coalescer calls `dispatch(message, concatenatedText)` — passing the **first buffered fragment's `TelegramIntakeMessage`** (stored in the `BufferEntry` when the buffer opened) with merged text. This is the same signature intake expects (`handleText(message, text)`); only the text is transformed. The first fragment's `message` is the right one to carry forward because it owns the `locator`, `threadId`, `isSupergroup`, `reply`, and `prepare` closures that the rest of the pipeline needs — later fragments from the same key share all of these by construction.

## Decisions

### D1: Length-gated, not universal debounce

**Chosen:** Only messages ≥4000 chars open a buffer. Short messages never enter or wait on the buffer.

**Why over a universal debounce:** A universal debounce adds latency to every message and, worse, destroys the steer affordance — today a quick second message while the runner is streaming acts as a redirect via `followUp`, and that is a feature. Length-gating means ordinary chat is zero-cost and steer semantics are untouched.

**Constraint introduced:** The 4000-char threshold is a heuristic. Telegram's 4096 limit has been stable for the platform's lifetime; if it ever moved, the threshold would need updating. The constant is module-scoped, so the fix is one line.

**Prior art:** Both hermes-agent (`_SPLIT_THRESHOLD = 4000`) and openclaw (`TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000`) chose this exact threshold independently.

### D2: Adjacent message_id as a split-corroboration signal

**Chosen:** A fragment is appended only if its `message_id` is exactly `lastBufferedId + 1`.

**Why over time-only:** Two independent implementations (hermes, openclaw) showed that time-of-arrival alone is brittle under clock skew or network jitter. Telegram assigns `message_id`s strictly monotonically per chat; a genuine split will always produce consecutive ids. The id check is a stronger signal than time and rejects the case of two merely-rapid messages that happen to arrive within the window. Goblin's grammy `ctx.msg.message_id` exposes this for free.

**Constraint introduced:** If a *different* chat member sends a message between the two halves of a user's split (so the second half's id jumps by more than 1), the split will not be detected and the second half dispatches standalone. This is rare (requires interleaving in a group during a paste) and the failure mode is graceful — the user gets a partial answer, not a crash. Single-user homelab makes this near-impossible.

**Prior art:** openclaw uses exactly this (`TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1`). hermes does not (time-only); we adopt the stronger signal.

### D3: Concatenation with no separator

**Chosen:** Fragments joined with `""`.

**Why over `"\n"`:** Telegram's client hard-cuts at 4096 with no delimiter — the first half ends mid-character-quence, the second half resumes. Joining with `"\n"` would inject a spurious newline and potentially split a word/line that the user wrote as one. The coalescer *knows* (via the id-adjacency corroboration) that these are fragments of one message, so the faithful reconstruction is plain concat.

**Risk and mitigation:** If the heuristic is ever wrong (two intentional ≥4000-char messages from one sender, back-to-back, with adjacent ids), concat merges them into one. The newline join would at least separate them. We judge this an acceptable failure: a user pasting two distinct 4000+ char documents within 1.2s with adjacent message ids is vanishingly rare, and the merged result is still intelligible text. The id-adjacency requirement makes accidental merge much harder than time-only would.

**Prior art:** openclaw uses `""` for its fragment path and `"\n"` for its *general* debouncer — the split personality confirms the principle: concat when you know it's a split, newline when you don't. We are in the "know it's a split" regime.

### D4: 1200 ms trailing debounce window

**Chosen:** 1.2 seconds, restarted on each appended fragment (trailing-edge debounce).

**Why this value:** Telegram client→server latency for a split's second half is typically sub-second, but under poor network can approach a second. 1.2s sits above the p99 of inter-fragment gap and below the threshold of user-perceived lag. Both references cluster here: hermes uses 1.0s for the split path; openclaw uses 1.5s. 1.2s is a defensible middle.

**Cost:** A split message's first half waits up to 1.2s before the agent sees anything. This is strictly better than today (today the first half dispatches immediately and the second half is lost/scrambled).

### D5: Hard caps at 12 fragments / 50,000 chars

**Chosen:** Flush immediately when either cap would be exceeded.

**Why:** Defensive bound against pathological or malicious input. A 50k-char message is already well past any reasonable single turn; 12 fragments × 4096 ≈ 49k, so the two caps roughly coincide. Costs nothing; prevents unbounded memory growth from a runaway sender.

**Prior art:** openclaw ships exactly these caps (`MAX_PARTS = 12`, `MAX_TOTAL_CHARS = 50_000`).

### D6: Slash commands flush-then-dispatch, never buffer

**Chosen:** A `bot_command` entity is never buffered. If a buffer is open, it is flushed first, then the command dispatches immediately.

**Why:** Commands mutate state (`/new`, `/cancel`, `/project`). Buffering a command would (a) delay a user's `/cancel` by 1.2s and (b) risk the command being interpreted against a stale runner. The flush-then-dispatch order preserves the user's intent: the buffered text they sent before the command reaches the agent first.

**Implementation note:** The coalescer does not parse commands itself. It checks whether the message text's first Telegram entity is `type === "bot_command"` — a cheap, grammy-accessible signal. This mirrors the existing allowlist middleware's entity inspection (`src/tg/middleware.ts`) and avoids importing `parseCommand` into the coalescer (which would invert the dependency: coalescer is a grammy-edge concern, command parsing is an intake concern).

### D7: Bucket key is `(chatId, topicId, fromUserId)`, not chatId alone

**Chosen:** Three-tuple key.

**Why:** In a group, two users pasting long messages simultaneously would collide on a chatId-only key and their fragments would interleave. The sender id disambiguates. The topic id keeps separate forum topics isolated. hermes's `build_session_key` and openclaw's debounce key both converge on this three-tuple.

### D8: Coalescer does not interact with steer / streaming state

**Chosen:** The coalescer delivers one `intake.handleText` call per logical message and knows nothing about `runner.isStreaming` or `followUp`.

**Why:** The steer-vs-queue decision is an intake concern (`intake.ts:452-457`), evaluated *after* the coalescer has done its job. By the time a merged message reaches `handleText`, the runner may have started streaming from a *previous* turn — that's fine, the existing policy applies to the merged message as a whole. Keeping the coalescer streaming-unaware keeps it a single, testable job (text merging) with no dependency on the agent layer.

### D9: First fragment's `TelegramIntakeMessage` is retained and carried on flush

**Chosen:** A `BufferEntry` stores the `TelegramIntakeMessage` from its first fragment (the one that opened the buffer). Every flush path — timeout, non-adjacent, command-flush, fragment cap, char cap — passes that first `message` to `dispatch`, not the message of whichever fragment triggered the flush.

**Why:** `intake.handleText(message, text)` needs a `TelegramIntakeMessage` to resolve the session, build the `MessageBuffer`, and run `prepare`. Every fragment that lands in one buffer shares the same `(chatId, topicId, fromUserId)` key, which means they share `locator`, `isSupergroup`, and `threadId` by construction (all derived from `ctx.chat`). The `reply`/`prepare` closures, however, are bound to whichever fragment's `ctx` built them: `reply` threads the reply to that fragment's message, and `prepare`'s `stripBotMention` reads that fragment's `entities`/`caption_entities` (via `ctx.msg`). Carrying the first fragment's `message` is therefore *not* strictly equivalent to carrying a later fragment's — but it is the simplest invariant (one write, one read, no per-fragment bookkeeping), and the divergence is benign:

- `reply` replying to the first fragment is the intended behavior (the agent's response anchors on the message that opened the turn).
- `prepare` applied to the *merged* text uses first-fragment entities, whose offsets are only valid within that fragment. Later-fragment entity offsets are not re-based onto the concatenated text. The practical consequence is that `stripBotMention`'s entity path runs on first-fragment entities only — but its plain-text fallback (`src/tg/user-context.ts`) still strips bare `@handle` occurrences anywhere in the merged text, so a bot mention in a later fragment is removed via the fallback as long as no entity-range match was found in the first fragment. Re-basing per-fragment entity offsets would be the full fix; it is accepted as out of scope because the residual edge case (a >4096-char message with bot mentions split across the boundary, where the first fragment already contains a mention and so disables the fallback) is vanishingly rare and its failure mode is benign (an extra `@handle` token reaches the prompt).

**Implementation note:** `submit` stores `input.message` in the `BufferEntry` at open time and never overwrites it on append. The append path only updates `text`, `lastBufferedId`, `fragmentCount`, and `totalChars`.

## File Changes

### NEW: `src/tg/coalesce.ts`

The coalescer module. Exports:

- `const TEXT_SPLIT_THRESHOLD = 4000` (and the other constants: `TEXT_SPLIT_WINDOW_MS = 1200`, `MAX_FRAGMENTS = 12`, `MAX_TOTAL_CHARS = 50_000`).
- `interface CoalesceKey { chatId: number; topicId: number | undefined; fromUserId: number }`
- `interface CoalesceInput { message: TelegramIntakeMessage; text: string; key: CoalesceKey; messageId: number; isCommand: boolean }`
- `class TextCoalescer` with a single public method `submit(input: CoalesceInput): void` (async internally via `setTimeout`; returns void synchronously, matching the fire-and-forget shape of `intake.handleText`'s callers).

The `submit` method implements the decision tree from the spec: open / append / flush-then-handle / pass-through / command-flush. Internal state is a `private readonly buffers: Map<string, BufferEntry>` keyed by a stringified `CoalesceKey`. The `BufferEntry` shape is `{ message: TelegramIntakeMessage; text: string; lastMessageId: number; fragmentCount: number; totalChars: number; timer: ReturnType<typeof setTimeout> }` — `message` is set once at open time (the opening fragment's message) and passed to `dispatch` on every flush path (D9).

Relates to spec requirements: *Text coalescer detects and merges Telegram-split messages*, *Slash commands bypass and flush the coalescer*, *Coalescer is constructed once per bot and keyed per sender*.

### NEW: `src/tg/coalesce.test.ts`

Colocated tests (per AGENTS.md test conventions — this is not in `src/subagents/`). Covers: open-on-threshold, append-on-adjacency, flush-on-timeout, flush-on-non-adjacent, short-pass-through, short-appends-to-open-buffer, fragment-cap, char-cap, command-flush, multi-sender-isolation, multi-topic-isolation. Uses fake timers (`bun:test`'s `useFakeTimers`) to drive the debounce deterministically.

### MODIFIED: `src/tg/mod.ts`

Add `export { TextCoalescer } from "./coalesce.ts"` and the relevant type/constant exports, so `bot.ts` can import the coalescer from the barrel. Mirrors the existing export pattern (`buildAllowlistMiddleware`, `locatorFromCtx`, etc.).

### MODIFIED: `src/bot.ts`

Three changes, all in `buildBot`:

1. **Construct** the coalescer alongside the other long-lived objects (after `intake` is created, since the coalescer needs to call `intake.handleText`): `const coalescer = new TextCoalescer({ dispatch: (msg, text) => intake.handleText(msg, text) });`
2. **Rewrite the `message:text` handler** (currently `bot.ts:103-105`) to route through the coalescer. Instead of `await intake.handleText(intakeMessageFromCtx(ctx), ctx.msg?.text)`, it builds the message once, extracts `fromUserId` and `messageId`, detects `isCommand` from the first entity, and calls `coalescer.submit(...)`.
3. The handler becomes the only grammy-facing caller of the coalescer; no other `bot.on(...)` handler changes (media paths bypass coalescing per the proposal Non-Goals).

Relates to spec requirement (MODIFIED): *Telegram intake module owns the update-to-turn seam* — specifically the scenario "bot.ts is a thin adapter" which now names the coalescer.

**Impact on callers:** None beyond `bot.ts`. `intake.handleText`'s signature is unchanged. The coalescer is the only new dependency, injected via the barrel export.

### NOT changed

- `src/tg/intake.ts` — `handleText` is called by the coalescer with the same arguments it receives today. No internal change.
- `src/orchestration/dispatcher.ts` — unaware of coalescing.
- `src/agent/` — unaware of coalescing.
- `src/tg/middleware.ts` — allowlist runs before the coalescer, unchanged.

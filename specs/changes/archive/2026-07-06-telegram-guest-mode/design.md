# telegram-guest-mode — Design

## Architecture

### Data flow

```
Telegram  ──getUpdates──▶  grammy Bot  ──bot.use()──▶  Allowlist middleware
                                                              │
                                              ┌───────────────┴────────────────┐
                                              │                                │
                                      (ctx.chat set)                   (guest_message)
                                       message:* handlers                      │
                                                                                ▼
                                                              new guest handler in buildBot
                                                                                │
                                                          intake.handleGuestMessage()
                                                                │
                                              ┌─────────────────┴──────────────────┐
                                              ▼                                    ▼
                                  SessionManager.resolve(                      AgentRunner.prompt(
                                    { chatId: foreignChatId },                   content,
                                    { isGuest: true }                            guestReplySink
                                  )                                            )
                                              │                                    │
                                  (auto-creates guest binding)                  accumulates full text,
                                                                                resolves on onAgentEnd
                                              │                                    │
                                              └──────────────► intake waits ◀──────┘
                                                                       │
                                                                       ▼
                                                  bot.api.raw.answerGuestQuery(
                                                    guestQueryId, InlineQueryResultArticle
                                                  )
```

The guest path is fully separate from the streaming `MessageBuffer` path. `AgentRunner.prompt(content, callbacks)` accepts any `TurnCallbacks`, so the guest sink is just a different `TurnCallbacks` implementation — the runner machinery is untouched.

### Why this shape

- **Middleware does access control; intake does turn orchestration; bot.ts is a thin adapter.** This matches the existing `telegram` canon ("Telegram intake module owns the update-to-turn seam"). The guest path follows the same seam, just with a different sink.
- **The guest sink is a new minimal `TurnCallbacks`, not a flag on `MessageBuffer`.** `MessageBuffer` is ~800 lines of streaming-edit logic, status-slot rendering, and topic-not-found handling. None of it applies to a one-shot `answerGuestQuery` reply. A separate ~40-line sink is smaller than any conditional path through `MessageBuffer`.
- **Session keying by foreign `chat.id`** reuses the existing locator/session machinery — only the bindings surface is new (`guest` map alongside `dm`/`topics`/`supergroups`). The `isGuest` option picks the binding map, the same way `isSupergroup` does today.

## Decisions

### D1: Detection via `bot.on("guest_message")`

grammy 1.44.0 ships native Bot API 10.0 support. `@grammyjs/types` 3.28.0's `Update` interface includes `guest_message?: Message & Update.NonChannel`, grammy's filter query table recognizes `guest_message` (`node_modules/grammy/out/filter.d.ts:1022`), and `guest_message` is in grammy's `DEFAULT_UPDATE_TYPES` (`node_modules/grammy/out/bot.d.ts:7`) so `bot.start()` requests it from `getUpdates` automatically.

**Decision:** use `bot.on("guest_message", handler)` — the idiomatic grammy path. No predicate composer, no local type assertions on `ctx.update`.

- **Why over alternatives (predicate composer / `bot.api.raw`):** those were workarounds for grammy 1.42.0, which the codebase used during investigation. We upgraded to 1.44.0 as phase 0 (commit `17eec0b`); the workarounds are no longer needed.
- **Constraint introduced:** the guest handler is a normal grammy handler — it runs through grammy's normal dispatch including `bot.catch`. No special try/catch wiring needed.

### D2: Reply via `ctx.answerGuestQuery(result)`

grammy 1.44.0 exposes `ctx.answerGuestQuery(result: InlineQueryResult, signal?)` (`node_modules/grammy/out/context.d.ts:1392-1399`), which auto-pulls `guest_query_id` from `this.guestMessage?.guest_query_id` (`node_modules/grammy/out/context.js:1299-1300`). It returns `Promise<SentGuestMessage>`.

**Decision:** call `await ctx.answerGuestQuery(result)` from the grammy handler, where `result` is an `InlineQueryResultArticle` wrapping `InputTextMessageContent(message_text = <full accumulated text>)`. We do not pass `parse_mode` — default plain text avoids "Bad Request: can't parse entities" when the model emits malformed markdown.

- **Why over alternatives (`bot.api.raw.answerGuestQuery` with a hand-rolled param type):** that was a workaround for grammy 1.42.0. With 1.44.0 the call is fully typed and `guest_query_id` is auto-read from context, so we never handle the id directly.
- **Constraint introduced:** `guest_query_id` hygiene is now automatic — the id lives inside grammy's context object and is read by `answerGuestQuery`; our code never names it. The spec requirement "`guest_query_id` is not persisted" still holds because we never extract it into a variable, log it, or write it to state.

### D3: Guest session bindings in a separate `guest` map

The current `BindingsFile` (`src/sessions/types.ts:31-38`) has `dm?: Record<string, string>`, `topics`, `supergroups?: Record<string, string>`, all keyed by `String(chatId)`. We add `guest?: Record<string, string>` with the same string-keyed shape, and lookups use `String(loc.chatId)` exactly as the `dm`/`supergroups` branches do (`src/sessions/manager.ts:114`). The `isGuest` option on `resolve()`/`createForChat()` selects this map.

**Why separate, not folded into `dm`:** a foreign `chat.id` is just a number; in principle it could collide with a normal DM chat id (the bot could later be added to that chat as a normal member, producing a real DM binding for the same id). Keeping the maps distinct means guest auto-create can never clobber a normal DM binding or vice versa. It also matches the existing pattern of one map per surface kind.

**Why `isGuest` is an option, not a new locator field:** the locator is `{ chatId, topicId? }` and is used pervasively (sessions, topic-settings, scheduler). Adding a `isGuest`/`surface` field to the locator would ripple through scheduler capture, topic-settings, and every consumer. An option on `resolve`/`createForChat` is local — only `manager.ts` and the new guest caller care.

- **Constraint introduced:** `peekBinding` (used by the scheduler) gains the same `isGuest` option. The scheduler will not pass `isGuest` (no scheduled turns for guest sessions in this change), so it never touches the `guest` map — but the option exists for type completeness.

### D4: Guest reply sink — minimal `TurnCallbacks`

A new class `GuestReplySink implements TurnCallbacks` (colocated in the intake module or `src/tg/guest-sink.ts`). It exposes:

```ts
class GuestReplySink implements TurnCallbacks {
  private buf = "";
  private done: (text: string) => void;
  private fail: (err: unknown) => void;
  // promise plumbing — expose a `done: Promise<string>`
  onTextDelta(t: string) { this.buf += t; }
  onToolStart() {}                       // no-op
  onToolEnd() {}                         // no-op
  onStatusUpdate() {}                    // no-op
  onAgentEnd() { this.done(this.buf); }
  // error path: runner errors propagate via prompt() rejection, not a callback;
  // intake awaits prompt() and handles the rejection.
}
```

The intake awaits `runner.prompt(content, sink)` (which resolves when the turn ends) and then reads `sink.text` (or has the sink hand it back via a resolved promise). Either shape works; we'll have the sink expose `text: string` read after `prompt()` resolves, which is simpler than juggling a separate promise.

- **Why over alternatives:** making `MessageBuffer` conditional on "guest mode" would force every streaming-method to grow a `if (guest) return early` guard, and the constructor's `chatId`/`topicId`/`bot` deps are wasted. A separate sink is ~30 lines.
- **Constraint introduced:** tool activity is invisible to the guest summoner. The reply is the final assistant text only. This is acceptable for guest mode (the use case is "answer my question," not "show tool telemetry") and is documented in the proposal's Non-Goals.

### D5: `guest_query_id` hygiene

With grammy 1.44.0, the `guest_query_id` never enters our code as a named value. `ctx.answerGuestQuery(result)` reads it internally from `ctx.guestMessage.guest_query_id` and includes it in the underlying API call. Our handler passes the whole `ctx` into the intake call (or calls `ctx.answerGuestQuery` directly), and the id is never extracted into a variable, logged, or written to state.

The investigation diagnostic that logged the raw update (including `guest_query_id`) was redacted in a prior step and is removed entirely in phase 4. The spec's "Diagnostic update-shape log is removed" and "`guest_query_id` never enters logs" scenarios formalize the cleanup.

**Test stub caveat:** the existing `buildAllowlistMiddleware` tests (`src/tg/middleware.test.ts:22-55`) construct `ctx` without an `update` field, so any `ctx.update` access throws under the current diagnostic. The phase-4 middleware change must guard with optional chaining (`ctx.update?.guest_message?.from?.id`) or use grammy's typed `ctx.guestMessage` accessor — verify against the test scaffolding before editing.

## File Changes

### Modified

- **`src/tg/middleware.ts`** — replace the temporary diagnostic block at the top of the returned middleware with the `guest_message` access check. Specifically:
  - Remove the `if ("guest_message" in ctx.update) { log.debug("GUEST update (redacted)" ...) }` block.
  - Insert, before the `if (!ctx.chat || !ctx.from)` guard: a branch that reads `(ctx.update as { guest_message?: { from?: { id?: number; username?: string } } }).guest_message`, checks `cfg.allowedTgUserIds.has(fromId)`, calls `next()` if allowed or returns silently with a debug log (matching the DM drop log shape) if not. The `guest_query_id` is intentionally not read here.
  - Satisfies: "Allowlist middleware gates guest_message updates by summoner" + "Diagnostic update-shape log is removed."

- **`src/bot.ts`** — register `bot.on("guest_message", handler)` after `bot.use(buildAllowlistMiddleware(cfg))` and before/after the `message:*` handlers (order does not collide — the filter only matches `guest_message`). The handler:
  - Reads `ctx.guestMessage` (grammy 1.44.0 alias for `ctx.update.guest_message`).
  - Drops (debug log) if `ctx.guestMessage?.text` is undefined (media guest message — Non-Goal; caption-only counts as no text).
  - Extracts `chat.id` from `ctx.guestMessage` (NOT `guest_query_id` — see D5).
  - Strips the `@botname` mention and prepends a sender prefix via `prepareUserContent(ctx, ctx.guestMessage.text)` (the adapter has `ctx`; the intake does not — this resolves the C2 finding that `stripBotMention`/`prepareUserContent` require `ctx`).
  - Calls `await intake.handleGuestMessage({ chatId, replyVia: (r) => ctx.answerGuestQuery(r) }, cleanedText)`.
  - grammy routes errors through `bot.catch` automatically; no special try/catch.
  - Satisfies: "buildBot wires a guest_message grammy handler."

- **`src/tg/intake.ts`** — add `handleGuestMessage(message, text)` to the `createTelegramIntake` return. The `message` argument carries `{ chatId: number; replyVia: (result: InlineQueryResult) => Promise<unknown> }` — a thin abstraction so the intake doesn't import grammy's `Context`. It:
  - Builds a locator `{ chatId: <foreign chat id> }` (no topicId).
  - Calls `manager.resolve(locator, { isGuest: true })` — auto-creates per D3.
  - Obtains (or creates) the session's `AgentRunner` via the existing dispatcher's runner cache.
  - If the runner is already streaming (`runner.isStreaming`), replies immediately via `message.replyVia` with a busy fallback (so `guest_query_id` is consumed before expiry) and returns — does NOT queue or call `prompt()`.
  - Constructs a `GuestReplySink`, calls `runner.prompt(text, sink)` (the text is already prepared by the bot.ts adapter).
  - Awaits `prompt()`. On success, calls `message.replyVia({ type: "article", id: crypto.randomUUID(), title: "Goblin", input_message_content: { message_text: sink.text || "(no response)" } })`. On `prompt()` rejection, calls `replyVia` with a fallback `{ type: "article", ..., input_message_content: { message_text: "⚠️ Something went wrong." } }`.
  - If `replyVia` itself rejects (expired `guest_query_id`), logs a warning and swallows — does not re-throw.
  - Never names or extracts `guest_query_id` — that lives entirely inside the `replyVia` closure.
  - Satisfies: "Guest message intake runs the agent to completion and replies once" + "Guest session locator keys on the foreign chat id."

- **`src/tg/mod.ts`** (barrel) — export `GuestReplySink` if colocated in a new file, or no change if colocated in `intake.ts`.

- **`src/sessions/types.ts`** — add `guest?: Record<number, string>` to `BindingsFile`. Add `isGuest?: boolean` to the options types of `resolve` and `createForChat` (and `peekBinding` for type completeness).
  - Satisfies: "Guest session bindings keyed on foreign chat id."

- **`src/sessions/manager.ts`** — extend `resolve(loc, opts?)` and `createForChat(loc, opts?)`:
  - When `opts?.isGuest` is true, read/write the `guest` map instead of the dm/topics/supergroups branch.
  - Auto-create on first resolve (mirror the topic auto-create branch at lines 116-128, but against the `guest` map).
  - Stale-binding auto-heal (mirror the topic stale branch).
  - `peekBinding(loc, opts?)` gains the same option.
  - Satisfies: "Auto-create guest sessions on first resolve" + "isGuest defaults to false."

- **`src/sessions/topic-settings.ts`** — likely no change: the sign-based DM/supergroup heuristic (lines 72-77) is only invoked by topic-settings consumers. Guest sessions have no `projectDir` surface in this change, so we do not extend topic-settings to guest locators. If `getProjectDir`/`bindProjectDir` are called with a guest locator, they would currently mis-route; the guest intake path will not call them. Verify during build.

### Created

- **`src/tg/guest-sink.ts`** — `GuestReplySink implements TurnCallbacks` per D4. ~30 lines. Colocated test `src/tg/guest-sink.test.ts` covering: text accumulation, tool events ignored, `onAgentEnd` resolves, default-empty result.
  - Satisfies: "Non-streaming reply sink for guest turns."

### Tests

- **`src/tg/middleware.test.ts`** — add cases for: allowed guest summon passes, non-allowed guest summon dropped with debug log, `guest_query_id` not in log payload.
- **`src/sessions/manager.test.ts`** (or colocated) — add cases for `resolve(loc, { isGuest: true })` first-call auto-create, second-call returns bound, stale auto-heal, isolation from `dm` map for the same chat id, `isGuest` default false unchanged.
- **`src/tg/intake.test.ts`** (existing test surface) — add cases for `handleGuestMessage`: success path calls `answerGuestQuery` once with the accumulated text; empty output sends fallback; `guest_query_id` not persisted to state/transcript; error path sends error fallback.

## Verification notes (claims checked against source)

- **grammy 1.44.0 upgrade landed** as commit `17eec0b`. Existing code typechecks clean (`bun run typecheck`) against the new types. 21 test failures in `buildAllowlistMiddleware` are pre-existing breakage from the investigation diagnostic (test stubs omit `ctx.update`, so `"guest_message" in ctx.update` throws); phase 4 removes that diagnostic and replaces it with a properly-guarded check.
- `@grammyjs/types` 3.28.0 `Update.guest_message` is `Message & Update.NonChannel` — verified `node_modules/@grammyjs/types/update.d.ts:48-49`. So `ctx.guestMessage` exposes `from`, `chat`, `text`, `guest_query_id` natively.
- `ctx.answerGuestQuery(result)` exists and auto-reads `guest_query_id` from `ctx.guestMessage` — verified `node_modules/grammy/out/context.js:1299-1300`.
- `guest_message` is in grammy's `DEFAULT_UPDATE_TYPES` — verified `node_modules/grammy/out/bot.d.ts:7`. So `bot.start()` requests it from `getUpdates` automatically; we do not need to pass `allowed_updates`.
- `AgentRunner.prompt(content, callbacks)` accepts arbitrary `TurnCallbacks` — verified `src/agent/mod.ts:339-347`. Runner sets `this.callbacks = callbacks` (line 351) and dispatches via `dispatchAgentEvent(event, this.callbacks)` (line 316). A custom sink will receive `onTextDelta`/`onAgentEnd` correctly.
- `BindingsFile` shape is `{ dm, topics, supergroups }` — to be re-verified at `src/sessions/types.ts:31-38` during build.
- `manager.resolve` branches topic (auto-create) vs supergroup (auto-create) vs DM (null) at `src/sessions/manager.ts:112-151` — to be re-verified during build before adding the `isGuest` branch.
- Test scaffolding for `buildAllowlistMiddleware` constructs `ctx` without an `update` field — verified `src/tg/middleware.test.ts:22-55`. The phase-4 middleware change must guard `ctx.update` access (optional chaining or `ctx.guestMessage` alias).

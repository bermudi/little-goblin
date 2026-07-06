# Tasks

## Phase 0: grammy upgrade (DONE — commit 17eec0b)

- [x] `bun update grammy @grammyjs/types` → grammy 1.44.0, @grammyjs/types 3.28.0
- [x] `bun run typecheck` clean against existing code
- [x] Commit as deps bump

Commit: `deps: bump grammy 1.42.0 -> 1.44.0, @grammyjs/types 3.26.0 -> 3.28.0`

## Phase 1: guest session binding surface

- [x] Re-read `src/sessions/types.ts` (BindingsFile shape) and `src/sessions/manager.ts` (resolve/createForChat/peekBinding branches) before editing — confirm the explore agent's report matches current code
- [x] Add `guest?: Record<number, string>` to `BindingsFile` in `src/sessions/types.ts`
- [x] Add `isGuest?: boolean` to the options of `resolve`, `createForChat`, and `peekBinding` (extend the option type or add a new overload — match the existing `isSupergroup` pattern)
- [x] In `SessionManager.resolve`, add an `opts?.isGuest` branch: auto-create on first resolve against the `guest` map (mirror the topic branch at lines ~116-128), auto-heal stale bindings (mirror the topic stale branch)
- [x] In `SessionManager.createForChat`, route to the `guest` map when `opts?.isGuest`
- [x] In `SessionManager.peekBinding`, accept `opts?.isGuest` and read the `guest` map (scheduler will not pass it; type-completeness only)
- [x] Verify the guest map is loaded/saved with `bindings.json` (no separate file) — extend the existing `loadBindings`/`saveBindings` to round-trip the new field
- [x] Add colocated tests in `src/sessions/manager.test.ts` (or the existing test file): `resolve(loc, { isGuest: true })` first-call auto-creates; second-call returns bound; stale auto-heal; guest binding does not collide with a `dm` binding for the same numeric chat id; `resolve(loc)` without `isGuest` is unchanged
- [x] `bun test && bun run typecheck` — phase must build and pass

Commit: `sessions: add guest binding surface`

## Phase 2: guest reply sink

- [x] Create `src/tg/guest-sink.ts` exporting `GuestReplySink implements TurnCallbacks` per design D4: `buf` accumulation in `onTextDelta`, no-op `onToolStart`/`onToolEnd`/`onStatusUpdate`, `onAgentEnd` resolves; expose `.text` read after `prompt()` resolves
- [x] Create `src/tg/guest-sink.test.ts`: text deltas accumulate, tool events ignored, `onAgentEnd` produces accumulated text, empty turn yields empty string
- [x] Export `GuestReplySink` from `src/tg/mod.ts` barrel
- [x] Satisfies spec: "Non-streaming reply sink for guest turns"
- [x] `bun test && bun run typecheck`

Commit: `tg: add guest reply sink`

## Phase 3: guest message intake

- [ ] Re-read `src/tg/intake.ts` `createTelegramIntake` return (line ~655), `handleText` (line ~352), and the dispatcher's runner-cache helper to confirm how to obtain-or-create a runner for a session. Confirm `runner.isStreaming` is the right busy-check (see `src/agent/mod.ts`).
- [ ] Add `handleGuestMessage(message: { chatId: number; replyVia: (result: InlineQueryResult) => Promise<unknown> }, text: string)` to the intake module. The `text` arrives already mention-stripped and sender-prefixed from bot.ts (do NOT call `stripBotMention` here — it needs `ctx` which the intake does not have; see C2 in review). It: builds locator `{ chatId }`; calls `manager.resolve(locator, { isGuest: true })`; obtains/creates the runner via the dispatcher. **Busy path**: if `runner.isStreaming`, calls `message.replyVia` once with a busy fallback and returns (no queue — `guest_query_id` would expire). **Normal path**: constructs `GuestReplySink`, awaits `runner.prompt(text, sink)`; on success calls `replyVia({ type: "article", id: crypto.randomUUID(), title: "Goblin", input_message_content: { message_text: sink.text || "(no response)" } })`; on `prompt()` rejection calls `replyVia` with `"⚠️ Something went wrong."`. **`replyVia` rejection**: log a warn and swallow.
- [ ] `InlineQueryResult` is imported from `@grammyjs/types` (or grammy) — already available via the upgrade. **Do not** extract or name `guest_query_id` — it lives inside the `replyVia` closure.
- [ ] Add `handleGuestMessage` to the `createTelegramIntake` return object
- [ ] Add intake tests: success path calls `replyVia` exactly once with accumulated text; empty output sends `"(no response)"` fallback; busy runner sends busy fallback without calling `prompt()`; `prompt()` rejection sends `"⚠️ Something went wrong."`; `replyVia` rejection is swallowed (logged warn, no throw); `guest_query_id` never named in code paths
- [ ] Satisfies spec: "Guest message intake runs the agent to completion and replies once" + "Busy runner replies with a fallback instead of queueing" + "replyVia rejection is swallowed" + "Guest session locator keys on the foreign chat id" + "Guest media message is ignored"
- [ ] `bun test && bun run typecheck`

Commit: `tg: add guest message intake`

## Phase 4: middleware + bot.ts wiring

- [ ] In `src/tg/middleware.ts`: insert, before the `if (!ctx.chat || !ctx.from)` guard, a `guest_message` branch that reads `ctx.update?.guest_message?.from?.id` (optional chaining — test stubs omit `ctx.update`, see `src/tg/middleware.test.ts:22-55`), allows via `cfg.allowedTgUserIds.has(fromId)` → `next()`, otherwise returns silently with a debug log (matching the DM drop shape). Do NOT read or log `guest_query_id`. (The diagnostic block was already removed in pre-build cleanup; verify it is gone.)
- [ ] In `src/bot.ts`: register `bot.on("guest_message", handler)` after `bot.use(buildAllowlistMiddleware(cfg))`. The handler reads `ctx.guestMessage`, drops media (no `text`, including caption-only) with debug log, **strips the mention and prepends sender prefix via `prepareUserContent(ctx, ctx.guestMessage.text)`** (adapter has `ctx`; intake does not — this resolves review C2), and calls `await intake.handleGuestMessage({ chatId: ctx.guestMessage.chat.id, replyVia: (result) => ctx.answerGuestQuery(result) }, cleanedText)`. grammy routes errors through `bot.catch` automatically.
- [ ] Update `src/tg/middleware.test.ts` `makeCtx` helper: add a `guestMessage?` option that populates `ctx.update.guest_message` so the new guard can be exercised
- [ ] Add middleware tests: allowed summoner's guest update calls `next()`; non-allowed summoner's guest update does not call `next()` and emits debug log WITHOUT `guest_query_id` in the payload
- [ ] Satisfies spec: "Allowlist middleware gates guest_message updates by summoner" + "buildBot wires a guest_message grammy handler" + "Non-guest updates do not hit the guest handler"
- [ ] `bun test && bun run typecheck`

Commit: `tg: wire guest_message handling`

## Phase 5: live verification

- [ ] Restart the bot in the `boo` session and confirm `bot online as`
- [ ] From the allowlisted account, send a guest mention in a foreign chat; confirm a single reply arrives in the foreign chat (not a DM to yourself)
- [ ] From a non-allowlisted account, send a guest mention; confirm NO reply and a `dropping guest_message from non-allowed user` debug line in scrollback with no `guest_query_id` in the payload
- [ ] Send a second guest mention from the same foreign chat; confirm the reply references prior context (per-chat session continuity)
- [ ] Check scrollback: confirm no `guest_query_id` value appears anywhere in logs; confirm `state/sessions/<id>/state.json` and `transcript.jsonl` for the guest session contain no `guest_query_id`

Commit: `telegram-guest-mode: live verification complete` (or amend into phase 4 — operator's choice)

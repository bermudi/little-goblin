# bot-dispatch-tests — Tasks

## Phase 1: Pin poe-validate and middleware with pure-unit tests

Add direct test coverage for the two smallest, easiest-to-cover load-bearing
modules flagged in the review. No production code changes — this phase is
test-only and serves as the safety net for the Phase 2 refactor (if a test
fails after the refactor, the bug is in the refactor, not in the modules).
This phase is independently shippable and may land separately from Phase 2.

- [x] Create `src/agent/poe-validate.test.ts`. Mock `globalThis.fetch` per-test (save and restore in `afterEach`).
  - Test: non-poe model name (`"openai/gpt-4o"`) → no `fetch` call, no throw
  - Test: poe model with known id (mock `fetch` to return `data: [{id: "Claude-Sonnet-4.6"}]`) → no throw
  - Test: poe model with unknown id and 3 close matches → throws, error message includes `"Did you mean: poe/<s1>, poe/<s2>, poe/<s3>?"`
  - Test: poe model with unknown id and no close matches → throws, error message includes `"See https://api.poe.com/v1/models for the full list."`
  - Test: poe model, `fetch` throws (network error) → calls injected `logger.warn` with the error, does not throw
  - Test: poe model, `fetch` returns 500 → calls `logger.warn` with `{ status: 500 }`, does not throw
  - Test: poe model, `fetch` returns 200 with `{ data: [] }` → calls `logger.warn` with empty list hint, does not throw
  - Test: non-2xx response (e.g. 401) when API key is invalid → warns, does not throw
  - Verify: `bun test src/agent/poe-validate.test.ts` passes
- [x] Create `src/tg/middleware.test.ts`. Build a fake `Context` per-test (a `MockBotApi` with `getChatMemberCount` mock, and a `MockCtx` with `chat`, `from`, `msg`, `me`). Use a `next = mock()` capture.
  - Test: DM from allowed user (id in `allowedTgUserIds`) → `next` called once
  - Test: DM from non-allowed user → `next` not called; debug log emitted (spy on `log.debug` if practical, or assert `next.mock.calls.length === 0`)
  - Test: group message with `mention` entity matching `@<botUsername>` from non-allowed user → `next` called
  - Test: group message with `text_mention` entity matching `ctx.me.id` → `next` called
  - Test: allowed user slash command in large group (member count 5) → `next` called, `getChatMemberCount` consulted
  - Test: allowed user slash command in small group (member count 2) → `next` called, `getChatMemberCount` consulted
  - Test: allowed user text in small group (member count 2) → `next` called
  - Test: allowed user text in large group (member count 5) without mention → `next` not called
  - Test: non-allowed user text in group without mention → `next` not called
  - Test: non-message update (`ctx.chat` undefined) → `next` called
  - Test: member-count cache — first call hits `getChatMemberCount`, second call within 5 min reuses cache, third call after TTL refreshes (use `mock.module("node:timers", ...)` or manipulate `Date.now()` with `vi.useFakeTimers()` equivalent; bun:test supports `mock` for `Date.now` via `setSystemTime`)
  - Test: `getChatMemberCount` throws → `next` not called for non-allowed users in groups, but the middleware treats the chat as `Infinity` for allowed-user routing (asserts the allowed-user branch still works after a thrown count)
  - Verify: `bun test src/tg/middleware.test.ts` passes
- [x] Create `src/tg/user-context.test.ts`. Build a fake `Context` with `me.username`, `from.first_name`, `from.username`, and controllable `msg.entities` / `msg.caption_entities`. Test `prepareUserContent` and `stripBotMention` (the latter is exported; the former is the public surface).
  - Test: text message with no entities → returns `"[From: Daniel (@bermudi)]\nhello"` (or similar canonical form)
  - Test: text message with `from.first_name` only (no username) → returns `"[From: Daniel]\nhello"`
  - Test: text message with no `from` → returns `"[From: unknown]\nhello"`
  - Test: text message with `mention` entity matching `@<botUsername>` → mention stripped
  - Test: text message with `text_mention` entity matching `ctx.me.id` → mention stripped
  - Test: text message with mention that does NOT match the bot (e.g. `@someone`) → preserved
  - Test: caption with mention entity (via `caption_entities`) → mention stripped
  - Test: content blocks (multimodal) → text blocks stripped of mentions, image blocks preserved, sender prefix prepended
  - Test: empty text after stripping → result is just the prefix
  - Verify: `bun test src/tg/user-context.test.ts` passes
- [x] Verify the full suite stays green: `bun test` — 667 + new tests, 0 fail

Implements spec requirements:
- **Allowlist middleware caches chat member counts with TTL** (telegram)
- **Allowlist middleware applies group-aware routing** (telegram)

## Phase 2: Extract dispatch seam and add bot integration tests

The big one. Extract the cancel-capable command switch from `bot.ts` into
a Telegram-side-effect-free function in `src/commands/dispatch.ts`, refactor `bot.ts`'s
`message:text` handler to call it, then add high-fidelity integration tests
that drive a real grammy `Bot` through `bot.handleUpdate(fakeUpdate)`.

- [x] Create `src/commands/dispatch.ts` exporting:
  - `type SideEffect = { kind: "runner-created", session: SessionState, locator: ChatLocator } | { kind: "runner-disposed", sessionId: string } | { kind: "noop" }`
  - `type DispatchResult = { kind: "replied", reply: string, sideEffects: SideEffect[] } | { kind: "fallthrough" }`
  - `type DispatchDeps = { manager: SessionManager; subagentRunner: SubagentRunner; cfg: Config; tryResolveModel: (...) => ResolvedModel | undefined; interruptAndCascade: typeof interruptAndCascade }` — **no** `runnerMap` and **no** `createRunner`; the dispatch returns runner side-effect descriptors, and the handler in `bot.ts` calls the real `createRunner` closure / mutates the runner map when applying them.
  - `type DispatchOpts = { command: string; ctx: Context; deps: DispatchDeps; rawText: string; session: SessionState | null; existingRunner: AgentRunner | null }` — `session` and `existingRunner` are pre-resolved by the handler (single `manager.resolve` + `runners.get` at the top of the `message:text` handler, reused for both the dispatch and the agent-routing path). The dispatch does NOT re-resolve.
  - `async function handleCancelCapableCommand(opts: DispatchOpts): Promise<DispatchResult>`
  - Move `CANCEL_CAPABLE_COMMANDS` from `src/bot.ts` (line 44) into `src/commands/dispatch.ts` and re-export it. The dispatch is the only consumer; `bot.ts` no longer needs the set.
  - The function body mirrors the existing switch in `bot.ts` lines ~258-600, with these changes:
    - All `runners.set(...)` calls become `{ kind: "runner-created", ... }` pushes to a `sideEffects: SideEffect[]` array
    - All `runners.delete(...)` and `prior.dispose()` calls (inside executor callbacks like `archive`, `setProjectDir`, `setModelName`) become `{ kind: "runner-disposed", sessionId }` pushes; the closure captures `sideEffects` from the dispatch's scope
    - All `await ctx.reply(...)` calls become `reply` strings returned in the result
    - All try/catch error replies become `kind: "replied"` results with the canned error text
    - All `log.error(...)` calls stay (the dispatch is allowed to log)
    - Default case returns `{ kind: "fallthrough" }`
  - Cascade is invoked as `await deps.interruptAndCascade(opts.existingRunner, deps.subagentRunner, DEFAULT_CASCADE_TIMEOUT_MS, opts.session?.id ?? null)` and the result is held for the cascade-timeout suffix in the reply
- [x] Create `src/commands/dispatch.test.ts` with unit tests (no real `Bot`, no `bot.api`). Build a `DispatchDeps` with a real `SessionManager` (via `mkdtempSync` like the existing `integration.test.ts`), a fake `SubagentRunner` (cast through `unknown`), a stubbed `tryResolveModel`, and a stubbed `interruptAndCascade` that returns a deterministic `CascadeResult`.
  - Test: `/cancel` with active session → result `kind: "replied"`, reply matches `cancelReply({...})` output, no side effects
  - Test: `/cancel` with no session → reply still produced (legacy mode cascade)
  - Test: `/new` with prior session → result contains `runner-disposed` for prior id and `runner-created` for new session
  - Test: `/new` with no prior session → result contains only `runner-created`
  - Test: `/new` executor throws → result `kind: "replied"`, reply is "Failed to reset session. Please try again."
  - Test: `/archive` with active session → result contains `runner-disposed`
  - Test: `/archive` with no session → reply is "No active session to archive." (no side effects)
  - Test: `/project /tmp/work` with active session → result contains `runner-disposed` (projectDir change forces runner rebuild)
  - Test: `/model <fav>` with active session → result contains `runner-disposed`; assert `manager.setModelName` was called via a spy on the `manager` mock
  - Test: `/model` lists favorites when no argument
  - Test: `/think high` with active session → no runner dispose (just sets thinking level on existing runner via callback)
  - Test: `/debug` with active session → reply contains session id and diagnostics text
  - Test: `/debug` with no session → reply is "No active session."
  - Test: `/compact` with active session → calls `runner.compact()` on existingRunner
  - Test: `/compact` with no session → reply is "No active session to compact."
  - Test: `/name foo` with active session → no runner dispose (just sets title)
  - Test: `/resume <id>` with matching session → result contains `runner-disposed` for prior and `runner-created` for resumed
  - Test: `/resume <id>` where the bound session IS the resumed session (no-op resume) → result contains BOTH `runner-disposed` (for the in-place prior runner) AND `runner-created` (for the new one). Pins the FIXED behavior.
  - Test: `/resume` (no arg) → reply lists named sessions
  - Test: `/help` → reply is `HELP_REPLY`, no side effects
  - Test: `/subagents` → reply is `SUBAGENT_STUB_REPLY`
  - Test: `/cancel_subagent abc` → reply is `SUBAGENT_STUB_REPLY`
  - Test: `/revive abc` → reply is `SUBAGENT_STUB_REPLY`
  - Test: unknown command (e.g. `/foo`) → result `kind: "fallthrough"`, no reply, no side effects
  - Test: cascade timeout surfaces in the reply (pass a `CascadeResult` with `timedOutSubagents: 1` from the stubbed `interruptAndCascade` and assert the reply contains the timeout suffix from `formatCascadeTimeoutSuffix`)
  - Verify: `bun test src/commands/dispatch.test.ts` passes
- [x] Refactor `src/bot.ts`'s `message:text` handler:
  - Lift `tryResolveModel` (existing closure) to be reachable as a `Deps` field. `createRunner` stays a closure inside `buildBot` (not in `Deps`) — the handler calls it when applying `runner-created` side effects.
  - Build a `deps: DispatchDeps` object once inside `buildBot` and capture it in the `message:text` handler closure.
  - **Resolve session + existingRunner ONCE at the top** of the handler, before the command parse:
    ```
    const session = manager.resolve(locator, { isSupergroup });
    const existingRunner = session ? runners.get(session.id) ?? null : null;
    ```
    Both the dispatch and the agent-routing path receive these values; the dispatch receives them via `DispatchOpts`.
  - **Fix the `/resume` same-session runner leak** at `bot.ts:553-565`. The current code gates the prior-runner dispose on `session.id !== resumeResult.session.id`, which is wrong — when the ids match, the dispose is skipped but the map entry is replaced, leaking the old runner. Change the gate to: always dispose the prior runner (if any) for `session.id` before `runners.set(...)`. Net effect: 2-line change in the refactored handler.
  - Replace the cancel-capable switch (lines ~258-600) with:
    ```
    const result = await handleCancelCapableCommand({ command, ctx, deps, rawText: rawText ?? "", session, existingRunner });
    if (result.kind === "fallthrough") {
      // continue to normal agent routing (existing code below the switch; reuses session + existingRunner)
    } else {
      for (const effect of result.sideEffects) {
        if (effect.kind === "runner-created") {
          runners.set(effect.session.id, createRunner(effect.session, locator, ctx));
          log.debug("created runner", { sessionId: effect.session.id });
        } else if (effect.kind === "runner-disposed") {
          const prior = runners.get(effect.sessionId);
          if (prior) { try { prior.dispose(); } finally { runners.delete(effect.sessionId); } }
          else { runners.delete(effect.sessionId); }
        }
      }
      if (result.reply) await ctx.reply(result.reply);
      return;
    }
    ```
  - Keep all existing error-handling around the dispatch call (try/catch) — if the dispatch itself throws, log and reply "Something went wrong. Please try again."
  - Verify: `bun test` — 667 + new dispatch tests still pass, 0 fail
  - Verify: `bun run typecheck` — no new TS errors
- [x] Create `src/bot.test.ts`. Build a `MockBotApi` with mocks for the Telegram API surface used by the selected scenarios (`getFile`, `getChatMemberCount`, `sendMessage`, `editMessageText`, `sendChatAction`, and any media send methods required by runner tools). Build a real `Bot` with `botInfo: { id: 1, username: "goblinbot", is_bot: true, first_name: "goblin" }`. Call `buildBot(cfg)` and replace `bot.api` with the mock after construction. Use `bot.handleUpdate(fakeUpdate)` to drive the first-pass scenarios.
  - Test: `/new` through `bot.handleUpdate` creates a session and replies
  - Test: `/archive` through `bot.handleUpdate` disposes/removes the runner and replies
  - Test: `/project <path>` through `bot.handleUpdate` changes project dir and forces runner rebuild/dispose
  - Test: DM without active session, user sends `/foo` (unknown command) → "No active session. Use /new" prompt sent
  - Test: photo message with image content → mock `getFile` returns `{ file_path: "photos/x.jpg" }`, mock `fetch` returns the bytes, `runner.prompt` called with multimodal content (text + image blocks)
  - Test: document message with unsafe filename (`"."`) → reply is "Rejected: unsafe filename.", no file written
  - Test: `message:text` in a topic where Telegram returns "topic not found" on the buffer's placeholder send → `onTopicNotFound` callback fires `memoryStore.archiveOrphan(chatId, topicId)`. Drive a non-command text message through `bot.handleUpdate`; have the runner mock emit a status update via the buffer's callbacks; mock `bot.api.sendMessage` to throw `{ error_code: 400, description: "Bad Request: topic not found" }` (the regex in `buffer.ts:863` matches `topic not found|message thread not found|invalid message thread id`); assert `memoryStore.archiveOrphan` was called with `(chatId, topicId)`.
  - Test: `/resume <id>` where the bound session IS the resumed session (no-op resume) → `agentRunners` map is replaced: old `AgentRunner.dispose()` is called, new `AgentRunner` is in the map. Pins the FIXED behavior (the 2-line change above). Pre-fix this would have leaked the old runner; post-fix it doesn't.
  - Test: allowlist drops non-allowed user in DM → `ctx.reply` not called, no command runs
  - Verify: `bun test src/bot.test.ts` passes
- [x] Verify the full suite stays green: `bun test` — 667 + new tests in phase 1 + new tests in phase 2, 0 fail
- [x] Verify: `bun run typecheck` — 0 errors
- [ ] Optional owner-driven smoke (out-of-band, not required for completion): `bun run src/onboard.ts` against a temp home, then `bun run src/index.ts` and send `/help` via Telegram — bot responds with the help text. The automated integration tests cover dispatch for this change.

Implements spec requirements:
- **Cancel-capable command dispatch is Telegram-side-effect-free** (commands)
- The end-to-end behaviour pinned by `specs/canon/commands/spec.md` is exercised by `src/bot.test.ts` (high-fidelity coverage that the existing `commands/integration.test.ts` does not provide)

## Out of scope (deferred)

- Live Telegram smoke test of all commands (existing `specs/backlog.md` v1.x item — unit/integration coverage from this change is the prerequisite).
- Per-command rate limiting (backlog v1.x).
- Refactoring the media handlers (no testability friction; the seam is unnecessary for them).
- `src/log.ts` tests (explicitly carved out by the review).

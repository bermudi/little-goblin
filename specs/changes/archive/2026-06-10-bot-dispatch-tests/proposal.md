# bot-dispatch-tests

## Motivation

The little-goblin codebase has 667 passing tests across 35 files, but the test
distribution is uneven and not principled. Coverage is dense at the leaves
(command executors, parsers, schema validators) and at single-class units
(`MessageBuffer`, `diagnostics`, `SessionManager`). Coverage is thin on the
load-bearing glue:

- `src/bot.ts` (1014 lines) wires every Telegram update to a side effect.
  It owns the security layer (`buildAllowlistMiddleware`), the entire
  cancel-capable command switch, the four media handlers
  (`message:photo | document | voice | audio`), and the two service-message
  handlers (`message:forum_topic_created | edited`). Zero direct tests.
  The 157-line `commands/integration.test.ts` covers dispatch *registration*
  (does `registerCommands` wire `/ping` and `/start`?) but not the dispatch
  *behaviour* (does `/new` archive the prior session and rebind the chat?).
- `src/agent/poe-validate.ts` (53 lines) is a startup-time model-id
  validator. One `fetch` call with four failure modes (network error,
  non-2xx, empty list, unknown id with optional close-match suggestion).
  Zero tests.
- `src/tg/middleware.ts` (130 lines) is the security allowlist. Five
  branches (DM allowlist, group @mention, allowed-user slash commands,
  allowed-user small-group text, default-deny) plus a 5-minute
  member-count cache. Zero direct tests.

The result: 667 passing tests give us confidence in leaves and parsers, not
in the wiring that actually runs in production. The AGENTS.md temp note
already flagged this — "src/bot.ts is approaching its limit" was true at
291 lines; the file is now 1014. The dispatch switch in the `message:text`
handler is 225 lines, ten cancel-capable commands, each with its own
runner-map / session-state / cascade dance.

There is also one known lifecycle bug in that switch: `/resume <id>` for the
session already bound to the chat replaces the runner map entry without
disposing the prior runner. The dispatch seam should pin and fix that runner
leak while preserving all user-facing replies.

This change closes that gap with three layered deliverables:

1. **Poe-validate + middleware tests** (cheap, pure-unit) — pin the
   existing behaviour so the security layer and startup validator can be
   refactored without surprise.
2. **A dispatch seam** in `bot.ts` — extract the cancel-capable command
   switch into a Telegram-side-effect-free function that takes
   `(command, ctx, deps)` and returns a structured result. This is the same refactor the AGENTS.md
   temp note proposed ("I'd extract a handleCommand(command, ctx,
   deps): Promise<boolean> so bot.ts becomes wire middleware, route to
   handler, error-handle").
3. **End-to-end `bot.ts` tests** through a real grammy `Bot` instance via
   `bot.handleUpdate(fakeUpdate)`, with a mocked `ctx.api` and a fake
   `SubagentRunner` / `agentRunners` map. This is what the review asked
   for: tests for the wiring that actually runs in production.

## Scope

### Phase 1 — Pure-unit tests for under-covered modules

Phase 1 is independently shippable test backfill. It should land before the
dispatch refactor if we want the smallest reviewable path.

- **Add `src/agent/poe-validate.test.ts`.** Mock `globalThis.fetch` to
  cover: non-poe model name (no fetch, no throw), poe model with known id
  (no throw), poe model with unknown id and close matches (throws with
  suggestions), poe model with unknown id and no close match (throws with
  the "see full list" hint), network error (warns, no throw), non-2xx
  response (warns, no throw), empty model list (warns, no throw).
- **Add `src/tg/middleware.test.ts`.** Build a fake `Context` with
  controllable `ctx.api.getChatMemberCount` and pass it through the
  middleware with `next = mock()`. Cover all five branches: DM
  allowlist pass, DM non-allowlist drop, group @mention pass, allowed
  user slash command in large group, allowed user text in ≤2-member
  group, default-deny. Cover the member-count cache: first call hits
  api, second call within TTL hits cache, third call after TTL refreshes.

### Phase 2 — Dispatch seam + bot integration tests

Phase 2 can be a separate change after Phase 1 lands. Its first pass should
cover the dispatch seam and the highest-risk bot wiring paths, not an
exhaustive Telegram/media matrix.

- **Extract the cancel-capable command dispatch into a new
  `src/commands/dispatch.ts`** exporting
  `handleCancelCapableCommand(opts: DispatchOpts): Promise<DispatchResult>`.
  The function:
  - Takes the parsed command, the grammy `Context`, a `Deps` bundle
    (`manager`, `subagentRunner`, `cfg`, `tryResolveModel`),
    and an `interruptAndCascade` reference (for direct test override).
  - Does not receive the runner map; runner lifecycle is represented only
    by returned side-effect descriptors and applied by `bot.ts`.
  - Computes the cascade interrupt (or skips for non-cancel-capable
    commands routed through here — though in practice we only route
    cancel-capable ones through the seam; the others stay in `bot.ts`).
  - Switches on the command. For each case, calls the existing executor
    (e.g. `executeNew`, `executeArchive`, `executeCompact`) and returns
    a structured `DispatchResult`:
    ```
    type DispatchResult = {
      reply: string;
      sideEffects: SideEffect[];
    };
    type SideEffect =
      | { kind: "runner-created", session: SessionState, locator: ChatLocator }
      | { kind: "runner-disposed", sessionId: string }
      | { kind: "replied", text: string } // when no side effects, just text
      | { kind: "noop" };
    ```
  - Returns a sentinel `{ kind: "fallthrough" }` result for unknown
    commands so the caller can route to normal agent routing.
- **Refactor `bot.ts`'s `message:text` handler** to call
  `handleCancelCapableCommand` for known commands, then translate the
  returned `sideEffects` into the actual runner-map mutations
  (`runners.set(...)`, `runners.delete(...)`, `prior.dispose()`) and
  `ctx.reply(...)` calls. The existing per-command try/catch and error
  replies stay in `bot.ts` (wiring concern, not dispatch).
- **Add a lean first pass of `src/bot.test.ts`** with a `MockBotApi` (mirroring the existing
  `tools.test.ts` and `buffer.test.ts` `MockBot` pattern) and
  `bot.handleUpdate(fakeUpdate)` for the highest-risk wiring cases. Cover:
  - `/new` creates a session and replies.
  - `/archive` disposes/removes the current runner and replies.
  - `/project` changes the project directory and forces runner rebuild/dispose.
  - `/resume <id>` where the bound session is the resumed session disposes the old runner before replacing it.
  - Unknown `/command` falls through to agent routing.
  - DM without active session → "Use /new" prompt, no agent call.
  - Photo message with image content → mock `getFile` + `fetch`,
    assert content blocks built correctly.
  - Unsafe filename (`"."`, `".."`) rejected.
  - Topic-not-found during status update archives orphaned topic memory.
  - Allowlist drops non-allowed user (smoke — full coverage is in the
    middleware test).
  - Additional media filename/content-length permutations are deferred unless
    a bug or implementation change touches them.
- **Update `specs/canon/commands/spec.md`** to add a new requirement
  pinning the dispatch seam contract.
- **Update `specs/canon/telegram/spec.md`** to add a new requirement
  pinning the middleware's member-count cache (so the cache behaviour
  has a stable spec target).

## Non-Goals

- **No behavioural change.** Every user-facing reply text, every state
  transition, every cascade timeout, every error path must remain
  byte-identical before and after this change. The refactor only
  restructures internal control flow.
- **No new commands.** This is not the place to add `/foo`. The dispatch
  seam supports today's 10 cancel-capable commands; new commands are
  future changes.
- **No changes to `registerCommands`** (the `bot.command()` registration
  for `/ping` and `/start`). Those are already exercised by the existing
  `integration.test.ts` and don't share the inline dispatch problem.
- **No changes to `MessageBuffer`**, `AgentRunner`, `SessionManager`,
  or the agent layer. The seam is in the dispatch glue only.
- **No new e2e / smoke tests against a live bot.** The existing
  `specs/backlog.md` v1.x item for an end-to-end smoke test of all
  commands remains deferred; this change is unit/integration coverage,
  not a full bot launch test.
- **No changes to the `migrate-to-ai-sdk`** in-flight change's
  surface. If a conflict surfaces during apply, the seam goes in `bot.ts`
  and the dispatch goes in `src/commands/dispatch.ts`; neither touches
  pi's AgentSession API.
- **No log.ts tests.** The log module is a 37-line threshold gate and
  string formatter; the review explicitly carved it out as "fine, it's a
  thin logger" and the litespec skill rule "test backfill without code
  change → fold into the phase that created the code" applies. If log
  ever grows a feature (file sink, JSON output), backfill tests then.
- **No removal of existing test files.** All 667 tests stay green. New
  tests add coverage; nothing is deleted.

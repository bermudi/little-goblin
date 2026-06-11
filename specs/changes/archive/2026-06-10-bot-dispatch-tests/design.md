# bot-dispatch-tests — Design

## Architecture

The change introduces a **dispatch seam** that splits `bot.ts`'s
`message:text` handler into a Telegram-side-effect-free function over a
`Deps` bundle (the dispatch) and a thin grammy-aware wrapper that applies
the resulting side effects (the wiring). The dispatch is not pure in the
functional sense: it may mutate session state through existing command
executors. The seam lives in `src/commands/dispatch.ts`.
The wiring stays in `src/bot.ts`. Media handlers (`message:photo |
document | voice | audio`) and service-message handlers
(`message:forum_topic_created | edited`) stay in `bot.ts` but gain direct
test coverage through `bot.handleUpdate(fakeUpdate)`.

The handler resolves the session and existing runner **once**, at the
top of the `message:text` handler. Both the dispatch and the
agent-routing path receive the same resolved values — no duplicate
`manager.resolve()` call.

```
                     ┌─────────────────────────────────────────────┐
                     │   src/commands/dispatch.ts                   │
                     │   handleCancelCapableCommand(opts)           │
                     │     • takes pre-resolved session + runner    │
                     │     • invokes interruptAndCascade (injected) │
                     │     • calls the right executor               │
                     │     • returns { reply, sideEffects }         │
                     │     • no bot.api, no ctx.reply, no mutate    │
                     │     • does NOT re-resolve session            │
                     └──────────────────┬──────────────────────────┘
                                        │  DispatchResult
                                        ▼
┌────────────────────────────────────────────────────────────────────┐
│   src/bot.ts — message:text handler (wiring)                       │
│   1. locator = locatorFromCtx(ctx)                                 │
│   2. isSupergroup = ctx.chat?.type === "supergroup"                │
│   3. session = manager.resolve(locator, { isSupergroup })          │
│   4. existingRunner = session ? runners.get(session.id) : null     │
│   5. command = parseCommand(ctx.msg?.text)                         │
│   6. if command !== null:                                          │
│        result = await handleCancelCapableCommand({                 │
│          command, ctx, deps, rawText, session, existingRunner })   │
│        if result.kind === "fallthrough":                           │
│          → fall through to agent routing (reuses session, runner)  │
│        else (result.kind === "replied"):                           │
│          for effect in result.sideEffects:                         │
│            if effect.kind === "runner-created":                    │
│              runners.set(effect.session.id,                        │
│                createRunner(effect.session, locator, ctx))         │
│            if effect.kind === "runner-disposed":                   │
│              prior = runners.get(effect.sessionId)                 │
│              if (prior) { try { prior.dispose() }                  │
│                            finally { runners.delete(...) } }       │
│              else { runners.delete(...) }                          │
│          if result.reply: await ctx.reply(result.reply)            │
│          return                                                    │
│   7. agent routing (reuses session, existingRunner, locator)       │
└────────────────────────────────────────────────────────────────────┘
```

### Deps bundle

The `Deps` object carries everything the dispatch needs from the bot's
wiring state, with no live coupling. It is constructed once in
`buildBot` and re-bound into the `message:text` handler closure.

```ts
export interface DispatchDeps {
  manager: SessionManager;
  subagentRunner: SubagentRunner;
  cfg: Config;
  /** Resolves a model given the current session and runner, or undefined. */
  tryResolveModel: (
    cfg: Config,
    session: SessionState | null,
    runner: AgentRunner | undefined,
  ) => ResolvedModel | undefined;
  /** Cascade interrupt; injected so tests can stub it. */
  interruptAndCascade: typeof interruptAndCascade;
}
```

The dispatch returns `runner-created` side effects; the handler in
`bot.ts` calls the real `createRunner` closure (which captures `bot`,
`manager`, `subagentRunner`, `memoryStore`, `getTopicName`, `cfg`) to
build the actual `AgentRunner`. The dispatch does not construct runners
and does not receive the runner map, so neither `createRunner` nor the map
is part of `DispatchDeps`.

### Side-effect model

The dispatch never mutates the runner map or calls `runner.dispose()`
directly. It records intent:

```ts
export type SideEffect =
  | { kind: "runner-created"; session: SessionState; locator: ChatLocator }
  | { kind: "runner-disposed"; sessionId: string }
  | { kind: "noop" };

export type DispatchOpts = {
  command: string;
  ctx: Context;
  deps: DispatchDeps;
  rawText: string;
  /** Pre-resolved by the handler — same value the agent routing path will use. */
  session: SessionState | null;
  /** Pre-resolved by the handler — the runner for `session`, or null. */
  existingRunner: AgentRunner | null;
};

export type DispatchResult =
  | { kind: "replied"; reply: string; sideEffects: SideEffect[] }
  | { kind: "fallthrough" };
```

The dispatch receives pre-resolved `session` and `existingRunner` from
the handler. The handler does the single `manager.resolve` call (and
the `runners.get` for the existing runner) and reuses the values for
both the dispatch and the agent-routing path. This eliminates a
duplicate session resolution per text message.

The handler in `bot.ts` translates `sideEffects` into runner-map
mutations. This is the only place that knows the runner map exists —
preserving the existing invariant that `Map<string, AgentRunner>`
lifecycle is owned by `bot.ts`.

### Test architecture

Three layers, increasing in fidelity:

1. **Pure-unit (no bot):** `handleCancelCapableCommand` is called with
   a hand-built `DispatchDeps` and a fake `Context` (the same `MockBot`
   pattern already used in `tools.test.ts` and `buffer.test.ts`). Tests
   assert on the returned `DispatchResult`.

2. **Wiring integration (real bot, mocked api):** `src/bot.test.ts`
   builds a real `new Bot(cfg.botToken, { botInfo: { id: 1, username:
   "goblinbot", is_bot: true, first_name: "goblin" } })`, calls
   `buildBot(cfg)`, and invokes `bot.handleUpdate(fakeUpdate)` with a
   hand-constructed `Update` shape. `bot.api.*` methods are replaced
   with mocks after construction
   (`(bot as { api: unknown }).api = mockApi;`). `globalThis.fetch` is
   mocked at the global level for file downloads. The first pass covers the
   riskiest wiring paths only (`/new`, `/archive`, `/project`, same-session
   `/resume`, unknown-command fallthrough, one photo happy path, unsafe
   document filename, topic-not-found orphan archival, allowlist smoke).
   Exhaustive media filename/content-length permutations are deferred until
   a bug or implementation change touches that surface.

3. **Helper isolation:** `poe-validate.test.ts` mocks
   `globalThis.fetch` and tests each branch of the validator in
   isolation. `middleware.test.ts` builds a fake `Context` with a
   controllable `ctx.api.getChatMemberCount` and a `next = mock()`
   function; the middleware's behaviour is asserted via the
   `next.mock.calls.length`.

### Mock-bot pattern (existing, extended)

The existing `MockBot` pattern (e.g. `src/tg/tools.test.ts`,
`src/tg/buffer.test.ts`) is the foundation. We extend it with:

- `MockBotApi` — a typed mock of the `ctx.api` surface used in `bot.ts`
  (`getFile`, `getChatMemberCount`, `sendMessage`, `editMessageText`,
  `sendChatAction`, `sendVoice`, `sendPhoto`, `sendDocument`,
  `editForumTopic`). Lives in `src/bot.test.ts` (or a small helper
  module if shared with `middleware.test.ts`).
- A `makeFakeUpdate(...)` helper that builds a `Update` object with
  the right shape for `message:text`, `message:photo`, etc.

## Decisions

### Seam location: `src/commands/dispatch.ts`, not inline in `bot.ts`

**Chosen:** The dispatch function lives in a new file
`src/commands/dispatch.ts` alongside the other command executors.

**Rejected alternative:** Inline the dispatch as a top-level function
in `bot.ts`. This keeps the file count down but `bot.ts` is already
1014 lines and the AGENTS.md temp note explicitly says "I'd extract a
handleCommand(command, ctx, deps): Promise<boolean> so bot.ts becomes
wire middleware, route to handler, error-handle." Putting the dispatch
in `bot.ts` would partly undo that goal.

**Rejected alternative:** Move the dispatch into `src/commands/mod.ts`.
`mod.ts` is currently a barrel that re-exports from `ping.ts` and
`start.ts`; the dispatch is more than a barrel and deserves its own
file.

**Trade-off:** New file in `commands/`. Matches the existing convention
of one concern per file in that directory.

### Side effects are a structured result, not callbacks or map access

**Chosen:** The dispatch returns a list of `SideEffect` descriptors and
the caller applies them. The dispatch does not receive the runner map.

**Rejected alternative:** Pass a `mutate(runnerMap, createRunner)`
function as part of `Deps` and let the dispatch call it. This couples
the dispatch to the runner-map shape (which the spec says is the
caller's concern) and makes the dispatch harder to test — tests would
have to assert on a mock mutation function instead of a structured
result.

**Rejected alternative:** Give dispatch a `runnerMap` field and promise not
to touch it. That is contradictory API design: if the seam must not mutate
the map, the map should not be in scope.

**Trade-off:** The dispatch result is verbose, but the verbosity pays
for itself in test clarity (`expect(result.sideEffects).toEqual([...])`).

### Inject `interruptAndCascade`, not re-implement it

**Chosen:** `interruptAndCascade` is a function reference in `Deps`,
imported as `typeof interruptAndCascade` to preserve the type.

**Rejected alternative:** Inline the cascade interrupt logic in the
dispatch. The cascade is already a 100-line pure function in
`src/interrupt.ts` with its own test file. Re-implementing it would
fork a tested invariant.

**Trade-off:** Adds one field to `Deps`. Tests can stub it to return a
deterministic `CascadeResult` (e.g. `{ attemptedMain: true, attemptedSubagents: 0,
timedOutMain: false, timedOutSubagents: 0 }`) without depending on
`interrupt.ts`'s timing.

### Inject `tryResolveModel` (not `createRunner`); pass pre-resolved session

**Chosen:** `tryResolveModel` is passed as a `Deps` field. `createRunner`
stays a private closure inside `buildBot` and is called by the handler
when applying `runner-created` side effects. `session` and
`existingRunner` are NOT in `Deps` — they're passed in `DispatchOpts`
because the handler has already resolved them once and the dispatch
should not resolve again.

**Why:** The current code in `bot.ts` does one `manager.resolve()` and
one `runners.get()` at the top of the `message:text` handler, then
shares the results across the cancel-capable switch and the
agent-routing path. Preserving this single-resolution invariant
requires the dispatch to take the resolved values as parameters, not
re-resolve internally.

**Rejected alternative:** Have the dispatch resolve internally
(earlier draft). Duplicates a JSON read per text message; the saving
is negligible but the contract becomes ambiguous ("does the dispatch
re-resolve or trust the caller?"). Pre-resolved is unambiguous.

**Trade-off:** `DispatchOpts` is bigger (six fields including
`session` + `existingRunner`). The dispatch is a one-time consumer of
these values; bigger opts is the right trade.

### `bot.handleUpdate` for integration tests, not `bot.start()`

**Chosen:** Tests construct a real `Bot`, install handlers via
`buildBot(cfg)`, and call `bot.handleUpdate(fakeUpdate)` directly.

**Why:** `bot.start()` begins long-polling, which hits the network.
`bot.handleUpdate(update)` runs the middleware/handler chain for a
single update synchronously, exactly like a real incoming update but
without a real Telegram server.

**Precedent:** grammy itself uses `bot.handleUpdate` in its test suite
to drive update routing without a network.

**Trade-off:** Need to construct `Update` objects by hand. The
`Update` type is a discriminated union; we write a `makeFakeUpdate`
helper per update kind we exercise (`message:text`, `message:photo`,
`message:document`, `message:voice`, `message:audio`,
`message:forum_topic_created`, `message:forum_topic_edited`).

### Replace `bot.api` with a mock after construction

**Chosen:** After `const bot = new Bot(...)`, the test casts the bot
and replaces `bot.api` with a mock object. Subsequent calls from
handlers go to the mock.

**Why:** Grammy's `bot.api` is created at construction time. There is
no "inject api" option. Mutating the field after construction is the
documented escape hatch for testing.

**Trade-off:** A TS lint warning about the cast is acceptable. The
pattern is the same one used in `tools.test.ts` (`bot as unknown as
Bot`).

### Service-message handlers and media handlers stay in `bot.ts`

**Chosen:** Only the cancel-capable dispatch moves to
`src/commands/dispatch.ts`. The `message:photo | document | voice |
audio` handlers and the `message:forum_topic_created | edited`
handlers stay in `bot.ts` and are tested via `bot.handleUpdate`.

**Why:** Those handlers are already small (40-100 lines each), already
isolate their file-download logic in `downloadFileBytes` /
`downloadPhoto`, and don't have the 14-way switch problem that
motivated the seam. Extracting them adds files without payoff.

**Trade-off:** Tests still drive them through grammy, which is the
high-fidelity layer the review asked for. No test is lost; only the
refactor scope is reduced.

### `registerCommands` is unchanged

**Chosen:** `/ping` and `/start` continue to be registered via
`bot.command(...)` in `registerCommands(bot, manager)`. The cancel-capable
switch moves to the dispatch seam. The two registration sites remain
distinct.

**Why:** The existing `commands/integration.test.ts` already exercises
`registerCommands`. Changing the registration model would invalidate
that test for no reason — `/ping` and `/start` don't share the
cancel-cascade problem.

**Trade-off:** Two registration sites (`bot.command()` for two
commands, `bot.on("message:text", ...)` for everything else). The spec
already documents this; we're not changing it.

### Fix the `/resume`-same-session runner leak in the refactor

**Chosen:** When `/resume` returns `kind: "resumed"`, the handler
unconditionally disposes the prior runner (if any) in the map for the
bound session, then sets the new runner. This is a 2-line change at
`bot.ts:553-565` of the existing code.

**Why:** The current code at `bot.ts:555` gates the dispose on
`session.id !== resumeResult.session.id`. When the resumed session
IS the bound session (no-op resume), the prior runner is not disposed
but is replaced in the map by `runners.set(...)` — leaking the old
`AgentRunner` and its underlying pi session. The gate is wrong; the
right behavior is to always dispose the prior runner before the set.

**Rejected alternative:** Pin the current behavior with a test and
flag for a follow-up. Codifying a leak in tests is worse than fixing
it — the test would lock in the bug, making it harder to fix later.
A 2-line fix during the refactor is the right move.

**Trade-off:** None. The change is local, the semantics are clearly
correct (always dispose before replace), and the existing
`commands/integration.test.ts` for `/resume` does not exercise the
no-op resume case — no test regression.

**Test:** The dispatch test for `/resume <id>` where the bound session
IS the resumed session asserts the result contains BOTH
`runner-disposed` (for the in-place prior runner) AND
`runner-created` (for the new one). The integration test in
`bot.test.ts` asserts the same.

## File Changes

### New files

| Path | Purpose | LOC est. |
|---|---|---|
| `src/commands/dispatch.ts` | `handleCancelCapableCommand` + `SideEffect` / `DispatchResult` / `DispatchDeps` types | ~250 |
| `src/commands/dispatch.test.ts` | Pure-unit tests for the dispatch (no real bot) | ~400 |
| `src/agent/poe-validate.test.ts` | Unit tests for `validateModelAtStartup` with mocked `fetch` | ~150 |
| `src/tg/middleware.test.ts` | Unit tests for `buildAllowlistMiddleware` with fake `Context` | ~250 |
| `src/bot.test.ts` | Integration tests for `bot.ts` through `bot.handleUpdate(fakeUpdate)` | ~600 |

### Modified files

| Path | Change |
|---|---|
| `src/bot.ts` | Lift the cancel-capable switch (lines ~258-600) into a call to `handleCancelCapableCommand`. The handler becomes: parse command → dispatch → apply side effects → reply (or fall through). Also accepts `botInfo` via the test (constructor already supports it; no change needed for that). |
| `specs/canon/commands/spec.md` | ADDED requirement: "Cancel-capable command dispatch is Telegram-side-effect-free" (delta) |
| `specs/canon/telegram/spec.md` | ADDED requirement: "Allowlist middleware caches chat member counts with TTL" + "Allowlist middleware applies group-aware routing" (delta) |

### Files NOT changed

- `src/commands/integration.test.ts` — keeps covering `/ping` and
  `/start` registration. The new `dispatch.test.ts` covers the
  cancel-capable dispatch in isolation; the two tests are
  complementary, not redundant.
- `src/tg/tools.test.ts`, `src/tg/buffer.test.ts` — the existing
  `MockBot` pattern is reused in `bot.test.ts`. No changes to the
  pattern itself.
- `src/agent/mod.ts` and friends — the agent layer is unchanged.
- `src/index.ts` — `main()` calls `buildBot` and `bot.start()`. Both
  still work; no change needed.
- `src/log.ts` — explicitly carved out as "fine, thin logger" by the
  review. Not in scope.
- `src/commands/<name>.ts` (executor files) — unchanged. The dispatch
  consumes the same executors with the same option shapes; the
  executors' callbacks (`setProjectDir`, `setTitle`, `archive`) still
  receive the same intent (manager call + a side-effect recorder).

## Spec requirement traceability

| Spec requirement (delta) | Implementation | Tests |
|---|---|---|
| Cancel-capable command dispatch is Telegram-side-effect-free | `src/commands/dispatch.ts` | `src/commands/dispatch.test.ts` |
| Allowlist middleware caches chat member counts with TTL | `src/tg/middleware.ts` (unchanged) | `src/tg/middleware.test.ts` |
| Allowlist middleware applies group-aware routing | `src/tg/middleware.ts` (unchanged) | `src/tg/middleware.test.ts` |

The end-to-end command behaviour ("Cancel during streaming aborts
main + subagents" etc.) is already covered by `commands/integration.test.ts`
and continues to pass through the refactor. The new
`src/bot.test.ts` adds high-fidelity coverage that drives the actual
`message:text` handler (not just the executors) through grammy.

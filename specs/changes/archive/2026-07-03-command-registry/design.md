## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │  src/commands/registry.ts                │
                    │  COMMAND_REGISTRY: readonly CommandDef[] │
                    │  ┌─────────────────────────────────────┐ │
                    │  │ per-command handler functions        │ │
                    │  │ (newHandler, archiveHandler, etc.)   │ │
                    │  └─────────────────────────────────────┘ │
                    └──────┬──────────────┬──────────────┬─────┘
                           │              │              │
              ┌────────────▼──┐  ┌────────▼────────┐  ┌──▼──────────────┐
              │ helpReply()   │  │ CANCEL_CAPABLE_  │  │ telegramBot     │
              │ → HELP_REPLY  │  │ COMMANDS (Set)   │  │ Commands()      │
              └───────────────┘  └────────┬────────┘  └──┬──────────────┘
                                         │              │
              ┌──────────────────────────┼──────────────┼──────────────┐
              │                          │              │              │
     ┌────────▼─────────┐    ┌───────────▼────┐  ┌──────▼──────┐  ┌────▼─────────┐
     │ dispatch.ts       │    │ dispatch.ts    │  │ index.ts    │  │ mod.ts       │
     │ handleCommand()   │    │ re-exports     │  │ setMyCommands│  │ registerCmds │
     │ resolve + call    │    │ the Set        │  │ at startup  │  │ iterate grammy│
     └───────────────────┘    └────────────────┘  └─────────────┘  └──────────────┘
```

`registry.ts` is the single source of truth. It holds:

1. The `CommandDef` interface and `COMMAND_REGISTRY` array.
2. Named handler functions (one per dispatched command) that wrap the existing `execute*` helpers and carry over the side-effect logic verbatim from the current `dispatch.ts` switch.
3. Derived helpers computed once at module load: `resolveCommand`, `CANCEL_CAPABLE_COMMANDS`, `helpReply`, `telegramBotCommands`.

`dispatch.ts` shrinks to: type definitions (`DispatchOpts`, `DispatchResult`, `SideEffect`, `DispatchDeps`), the `replied`/`errorMessage` helpers, a re-export of `CANCEL_CAPABLE_COMMANDS`, and `handleCommand` — which resolves, cascades if needed, and calls `def.handler`.

`bot.ts` is unchanged: it still calls `handleCommand` in its `message:text` handler and applies the returned `sideEffects` to the `runners` map. The `bot` parameter still flows through `DispatchOpts` to the `/voice` handler (the only handler that needs `bot` for `executeVoice`).

## Decisions

### Handlers live in registry.ts, not separate files

**Chosen:** The per-command handler functions (`newHandler`, `archiveHandler`, `modelHandler`, …) live in `src/commands/registry.ts` alongside the `CommandDef` entries that reference them.

**Rejected alternative:** A separate `src/commands/handlers/` directory with one file per command. This would create ~15 tiny wrapper files that mostly just call the existing `execute*` helpers and push side effects — high ceremony for refactoring working code. It would also split the registry across two locations: metadata in `registry.ts`, behavior in `handlers/`, making it harder to see a command's full picture in one place.

**Trade-off:** `registry.ts` becomes ~250 lines (metadata + handlers + derived helpers). This is larger than a pure metadata file, but its job is "be the command registry including dispatch" — that is the point of the refactor. It stays within the "one module, one job" guardrail because the job is cohesive: define commands and their dispatch behavior in one place. The existing `execute*` helpers (`executeNew`, `executeArchive`, etc.) remain in their own files — `registry.ts` handlers are thin wrappers over them, not reimplementations.

### CommandContext extends DispatchOpts with cascade and suffix

**Chosen:** The handler signature is `CommandHandler = (ctx: CommandContext) => Promise<DispatchResult>` where `CommandContext extends DispatchOpts { cascade: CascadeResult | null; suffix: () => string }`. The `cascade` and `suffix` are computed inside `handleCommand` after the cancel-capable check and passed in.

**Why:** Today's switch computes `cascade` and `suffix` in scope and references them from each case. Moving the logic into handler functions requires passing these explicitly. Non-cancel-capable handlers receive `cascade: null` and an empty `suffix()` — they simply don't use them.

**Rejected alternative:** Make `cascade`/`suffix` optional on `CommandContext` and only set them for cancel-capable defs. This would force every handler to null-check, adding noise. Passing `null` + empty suffix for non-cancel-capable handlers is cleaner — the handlers that need them use them, the rest ignore them.

### grammyHandler is a factory, not a direct handler

**Chosen:** `grammyHandler?: (deps: { manager: SessionManager }) => (ctx: Context) => Promise<void>` — a factory that receives the `SessionManager` and returns the grammy handler. This matches the existing `buildStartHandler(manager)` pattern.

**Why:** `/start` needs the `SessionManager` to create sessions. `/ping` doesn't, but the factory signature is uniform — `pingHandler`'s factory ignores the `manager` argument. `registerCommands()` calls `bot.command(name, def.grammyHandler({ manager }))` for each grammy def.

### setMyCommands is best-effort, called once at startup

**Chosen:** In `src/index.ts`, after `buildBot` and before `bot.start`, call `await bot.api.setMyCommands(telegramBotCommands())`. On failure, `log.warn` and continue.

**Why:** `setMyCommands` is a one-shot Telegram API call that configures the client-side `/` autocomplete menu. It is not on the critical path — commands still dispatch via the `message:text` handler regardless of whether the menu is populated. A failure (network error, rate limit) should not prevent the bot from starting. This mirrors the existing `assertEdgeTtsAvailable()` pattern: try, warn on failure, continue.

**Rejected alternative:** Call `setMyCommands` inside `buildBot` or `registerCommands`. This would couple the registry derivation to the bot construction and make it harder to test `buildBot` without hitting the Telegram API. Keeping it in `index.ts` (the startup orchestrator) is cleaner.

### Telegram name sanitization

**Chosen:** `telegramBotCommands()` sanitizes each def's `name`: lowercase, hyphens → underscores, truncated to 32 chars, validated against `^[a-z][a-z0-9_]{0,31}$`. Aliases are excluded — one menu entry per canonical command. Descriptions are truncated to 256 chars (Telegram's limit).

**Why:** Telegram's `BotCommand` spec requires names matching `^[a-z][a-z0-9_]{0,31}$`. little-goblin's command names are already lowercase and hyphen-free (`cancel_subagent` uses underscores), so sanitization is a no-op today — but the function is defensive against future commands with hyphens. Excluding aliases matches hermes's behavior and avoids menu clutter.

### No cli_only / gateway_only / config-gate fields

**Chosen:** `CommandDef` carries only fields little-goblin needs: `name`, `description`, `aliases`, `argsHint`, `cancelCapable`, `handler`/`grammyHandler`. No `cli_only`, `gateway_only`, `gateway_config_gate`, or `category`.

**Why:** little-goblin is single-surface (Telegram). hermes's multi-platform fields would be dead weight. The `category` field was initially included for future help-text grouping but removed per YAGNI — no consumer reads it, and adding it back when a consumer arrives is trivial.

## File Changes

### `src/commands/registry.ts` (new)

The single source of truth. Exports:

- `CommandDef` interface
- `CommandHandler` type, `CommandContext` type (extends `DispatchOpts` with `cascade` and `suffix`)
- `COMMAND_REGISTRY: readonly CommandDef[]`
- `resolveCommand(token: string): CommandDef | null`
- `CANCEL_CAPABLE_COMMANDS: Set<string>` (with leading `/`, names + aliases of cancel-capable defs)
- `helpReply(): string`
- `telegramBotCommands(): { command: string; description: string }[]`
- Named handler functions (not exported — referenced by `COMMAND_REGISTRY` entries)

Handlers wrap the existing `execute*` helpers, carrying over the exact side-effect logic from `dispatch.ts`'s switch cases:
- `cancelHandler` — calls `cancelReply` with the cascade result
- `newHandler` — calls `executeNew`, pushes `runner-disposed` + `runner-created`
- `archiveHandler` — calls `executeArchive`, pushes `runner-disposed`
- `projectHandler` — calls `executeProject`, pushes `runner-disposed`
- `modelHandler` — calls `executeModel`, applies `runner.setModel` in-place on `set`/`cleared`
- `thinkHandler` — calls `executeThink`, applies `setThinkingLevel` in-place
- `debugHandler` — calls `generateDiagnostics`
- `compactHandler` — calls `executeCompact`
- `nameHandler` — calls `executeName`
- `resumeHandler` — calls `executeResume`, pushes `runner-disposed` + `runner-created`
- `subagentsHandler` — calls `formatSubagentsList`
- `cancelSubagentHandler` — parses id, calls `subagentRunner.cancel`
- `reviveHandler` — parses args, calls `subagentRunner.revive`
- `helpHandler` — returns `HELP_REPLY` (via `helpReply()`)
- `voiceHandler` — calls `executeVoice`, branches on result kind
- `queueHandler` — pushes `queue-prompt` side effect
- `pingGrammyHandler` — factory returning `pingHandler` (ignores `manager`)
- `startGrammyHandler` — factory returning `buildStartHandler(manager)`

Implements spec requirements:
- **Command registry is single source of truth**
- **Telegram command menu is populated at startup** (derivation)
- **Help command lists available commands** (derivation)
- **Register command handlers on bot** (derivation)
- **Cancel-capable command dispatch is Telegram-side-effect-free** (handler implementations)

### `src/commands/dispatch.ts` (rewritten)

Shrinks from ~330 lines to ~40. Keeps:
- `SideEffect`, `DispatchResult`, `DispatchDeps`, `DispatchOpts` types
- `replied`, `errorMessage` helpers
- Re-export of `CANCEL_CAPABLE_COMMANDS` from `registry.ts` (preserves `dispatch.test.ts` import)
- `handleCommand(opts: DispatchOpts): Promise<DispatchResult>` — resolve via `resolveCommand`, return `fallthrough` if null or no `handler`, cascade if `cancelCapable`, call `def.handler({ ...opts, cascade, suffix })`, return result.

Removes: the 230-line switch, all `execute*` imports (moved to `registry.ts`), the `HELP_REPLY` import (moved to `registry.ts`).

Implements spec requirement: **Cancel-capable command dispatch is Telegram-side-effect-free** (MODIFIED).

### `src/commands/help.ts` (rewritten)

Becomes a one-liner: `export const HELP_REPLY = helpReply();` re-exported from `registry.ts`. Keeps `help.test.ts` and `dispatch.test.ts` imports working unchanged.

Implements spec requirement: **Help command lists available commands** (MODIFIED).

### `src/commands/mod.ts` (rewritten)

`registerCommands(bot, manager)` iterates `COMMAND_REGISTRY.filter(c => c.grammyHandler)` and calls `bot.command(c.name, c.grammyHandler({ manager }))`. Replaces the hardcoded `ping`/`start` registrations.

Implements spec requirement: **Register command handlers on bot** (MODIFIED).

### `src/index.ts` (modified)

Add after `buildBot` / `manager.init()`, before `bot.start`:

```typescript
try {
  await bot.api.setMyCommands(telegramBotCommands());
} catch (err) {
  log.warn("setMyCommands failed; / autocomplete menu may be stale", {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

Import `telegramBotCommands` from `./commands/registry.ts`.

Implements spec requirement: **Telegram command menu is populated at startup**.

### `src/commands/registry.test.ts` (new)

Drift guards and derived-helper tests:
- `helpReply()` contains every spec-mandated command (port from `help.test.ts`)
- `CANCEL_CAPABLE_COMMANDS` matches expected set (`/cancel` in; `/voice`, `/queue` not in — port from `dispatch.test.ts`)
- `telegramBotCommands()` returns valid `BotCommand` entries (no aliases, sanitized names ≤32, descriptions ≤256)
- `resolveCommand` resolves names + aliases + leading-slash; returns `null` for unknown
- Drift guard: no duplicate names/aliases; every def has exactly one of `handler`/`grammyHandler`; all `cancelCapable` defs have `handler`

### No changes to

- `src/commands/parse.ts` — `parseCommand()` stays as-is; the registry consumes its output
- `src/commands/*.ts` (execute helpers: `new.ts`, `archive.ts`, `project.ts`, `model.ts`, `think.ts`, `compact.ts`, `name.ts`, `resume.ts`, `subagents.ts`, `voice.ts`, `cancel.ts`, `ping.ts`, `start.ts`) — unchanged; `registry.ts` handlers call them
- `src/bot.ts` — unchanged; still calls `handleCommand` and applies `sideEffects`
- `src/commands/dispatch.test.ts`, `src/commands/help.test.ts` — unchanged; they import `CANCEL_CAPABLE_COMMANDS` / `HELP_REPLY` which still resolve
- `src/commands/integration.test.ts` — unchanged; exercises `handleCommand` end-to-end

## Phase 1: Command registry module

Create `src/commands/registry.ts` with `CommandDef`, `COMMAND_REGISTRY`, handler functions, and derived helpers. This phase delivers the registry as a standalone module — no consumers wired yet, so `dispatch.ts` / `help.ts` / `mod.ts` still use their old code paths. The registry must compile and its self-consistency tests must pass.

- [x] Create `src/commands/registry.ts` exporting:
  - `CommandDef` interface: `name`, `description`, `aliases?`, `argsHint?`, `cancelCapable?`, exactly one of `handler?: CommandHandler` or `grammyHandler?: (deps: { manager: SessionManager }) => (ctx: Context) => Promise<void>`
  - `CommandHandler` type: `(ctx: CommandContext) => Promise<DispatchResult>`
  - `CommandContext` type: extends `DispatchOpts` with `cascade: CascadeResult | null` and `suffix: () => string`
  - `COMMAND_REGISTRY: readonly CommandDef[]` — one entry per command (cancel, new, archive, project, model, think, debug, compact, name, resume, subagents, cancel_subagent, revive, help, voice [alias v], queue, ping [grammy], start [grammy])
  - Named handler functions wrapping the existing `execute*` helpers, carrying over the exact side-effect logic from `dispatch.ts`'s switch cases verbatim (runner-created / runner-disposed / queue-prompt pushes, error logging, in-place `runner.setModel` / `setThinkingLevel`)
  - `resolveCommand(token: string): CommandDef | null` — strips leading `/`, matches name + aliases
  - `CANCEL_CAPABLE_COMMANDS: Set<string>` — `"/" + name` and `"/" + alias` for every `cancelCapable` def
  - `helpReply(): string` — one line per def: `/<name><args> — <description>` (args = ` ` + argsHint if present)
  - `telegramBotCommands(): { command: string; description: string }[]` — sanitized names (lowercase, hyphens → underscores, ≤32 chars, `^[a-z][a-z0-9_]{0,31}$`), aliases excluded, descriptions ≤256 chars
- [x] Create `src/commands/registry.test.ts`:
  - `helpReply()` contains every spec-mandated command (port the required-set assertion from `help.test.ts`)
  - `CANCEL_CAPABLE_COMMANDS` matches expected set: `/cancel`, `/new`, `/archive`, `/project`, `/model`, `/debug`, `/compact`, `/resume`, `/name`, `/think` in; `/voice`, `/v`, `/queue`, `/ping`, `/start`, `/help`, `/subagents`, `/cancel_subagent`, `/revive` not in
  - `telegramBotCommands()` returns valid entries: no aliases, sanitized names ≤32, descriptions ≤256, one entry per canonical name
  - `resolveCommand` resolves names + aliases + leading-slash; returns `null` for unknown
  - Drift guard: no duplicate names/aliases across registry; every def has exactly one of `handler`/`grammyHandler`; all `cancelCapable` defs have `handler` (not `grammyHandler`)
- [x] Verify: `bun test src/commands/registry.test.ts` passes

Implements spec requirements:
- **Command registry is single source of truth** (structure + derived helpers)
- **Telegram command menu is populated at startup** (derivation helper)
- **Help command lists available commands** (derivation helper)

## Phase 2: Wire registry into dispatch, help, and mod

Replace the hand-maintained consumers with registry-derived ones. After this phase, `handleCommand` resolves via the registry, `HELP_REPLY` is computed from the registry, and `registerCommands` iterates grammy defs. The existing `dispatch.test.ts`, `help.test.ts`, and `integration.test.ts` must pass unchanged — they are the behavior-preservation safety net.

- [x] Rewrite `src/commands/dispatch.ts`:
  - Keep `SideEffect`, `DispatchResult`, `DispatchDeps`, `DispatchOpts` types and `replied` / `errorMessage` helpers
  - Re-export `CANCEL_CAPABLE_COMMANDS` from `registry.ts` (preserve `dispatch.test.ts` import)
  - Replace `handleCommand` body: `resolveCommand(command)` → if null or no `handler`, return `fallthrough` → if `cancelCapable`, run `interruptAndCascade` → call `def.handler({ ...opts, cascade, suffix })` → return result
  - Remove the 230-line switch and the `execute*` / `HELP_REPLY` imports (now in `registry.ts`)
- [x] Rewrite `src/commands/help.ts`: `export const HELP_REPLY = helpReply();` re-exported from `registry.ts`
- [x] Rewrite `src/commands/mod.ts`: `registerCommands` iterates `COMMAND_REGISTRY.filter(c => c.grammyHandler)` and calls `bot.command(c.name, c.grammyHandler({ manager }))`
- [x] Verify: `bun test src/commands/dispatch.test.ts` passes (unchanged — exercises new `handleCommand` end-to-end)
- [x] Verify: `bun test src/commands/help.test.ts` passes (unchanged — `HELP_REPLY` still resolves)
- [x] Verify: `bun test src/commands/integration.test.ts` passes
- [x] Verify: `bun test` (full suite) green

Implements spec requirements:
- **Cancel-capable command dispatch is Telegram-side-effect-free** (MODIFIED — resolve + call)
- **Help command lists available commands** (MODIFIED — derives from registry)
- **Register command handlers on bot** (MODIFIED — iterates grammy defs)

## Phase 3: Populate Telegram command menu at startup

Call `setMyCommands` once at startup with the registry-derived payload. This is the user-visible win — Telegram's `/` autocomplete menu goes from empty to populated.

- [x] In `src/index.ts`, import `telegramBotCommands` from `./commands/registry.ts`
- [x] After `manager.init()` and before `bot.start`, add:
  ```typescript
  try {
    await bot.api.setMyCommands(telegramBotCommands());
  } catch (err) {
    log.warn("setMyCommands failed; / autocomplete menu may be stale", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  ```
- [x] Verify: `bun run src/index.ts` starts without errors; `setMyCommands` call fires (check logs for warning on failure)
- [x] Manual: open Telegram, type `/` in a DM with the bot — autocomplete menu shows the commands
- [x] Manual: `/help` reply text unchanged from before the refactor
- [x] Manual: `/v` still aliases `/voice` (voice note generated)
- [x] Manual: `/cancel` still interrupts an active turn

Implements spec requirement: **Telegram command menu is populated at startup**

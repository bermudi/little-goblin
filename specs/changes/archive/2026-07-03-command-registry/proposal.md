## Motivation

Today little-goblin has three places that can drift:

- `src/commands/help.ts` — `HELP_REPLY` is a hand-maintained string array.
- `src/commands/dispatch.ts:34` — `CANCEL_CAPABLE_COMMANDS` is a separate hand-maintained `Set`, and a 230-line `switch (command)` with no relationship to the help text.
- `src/commands/mod.ts` — `bot.command("ping")` / `bot.command("start")` are registered separately, with a comment explaining the rest bypass grammy's command middleware.

Worse, `setMyCommands` is never called — Telegram's `/` autocomplete menu is empty for the user. Adding a command or alias means editing all three places (and remembering to do so); forgetting one produces silent drift the tests only catch for the explicitly pinned set.

The pattern is solved elsewhere (hermes-agent's `CommandDef` registry): one list of `CommandDef` entries drives help text, the cancel-capable set, dispatch, grammy `bot.command()` registrations, and the Telegram `BotCommand` menu. Adding an alias is one tuple edit.

## Scope

### Single command registry

A new `src/commands/registry.ts` exports `COMMAND_REGISTRY: readonly CommandDef[]` — one entry per slash command (`/cancel`, `/new`, `/archive`, `/project`, `/model`, `/think`, `/debug`, `/compact`, `/name`, `/resume`, `/subagents`, `/cancel_subagent`, `/revive`, `/help`, `/voice` with alias `/v`, `/queue`, `/ping`, `/start`).

Each `CommandDef` carries: canonical `name`, `description`, `aliases`, `argsHint`, `cancelCapable` flag, and exactly one of `handler` (dispatched in the `message:text` path) or `grammyHandler` (registered via `bot.command()`).

### Derived consumers

Every existing consumer derives from the registry:

- `HELP_REPLY` (in `help.ts`) — built from `name` + `argsHint` + `description`.
- `CANCEL_CAPABLE_COMMANDS` (re-exported from `dispatch.ts`) — names + aliases of `cancelCapable` defs.
- `registerCommands()` (in `mod.ts`) — iterates `grammy` defs and calls `bot.command(name, grammyHandler(...))`.
- `handleCommand()` (in `dispatch.ts`) — resolves the command token via `resolveCommand()`, runs the cancel-capable cascade if flagged, and calls `def.handler(...)`. The 230-line switch collapses into resolve + call.
- `bot.api.setMyCommands(...)` (in `index.ts`) — called once at startup with the registry-derived `BotCommand[]` (sanitized names, aliases excluded, descriptions ≤256 chars). Failure is non-fatal (`log.warn` + continue).

### Behavior preservation

The per-command side-effect logic (`runner-created` / `runner-disposed` / `queue-prompt`) and error logging from the current switch cases move verbatim into named handler functions in `registry.ts`. The dispatch tests are the safety net — if any case drifts, they fail. `/help` reply text, `/v` aliasing `/voice`, and the cancel-capable set membership all remain as today.

## Non-Goals

- **No new commands.** This change restructures how existing commands are registered and surfaced; it does not add or remove any command.
- **No multi-surface fields.** little-goblin is single-surface (Telegram). `CommandDef` carries no `cli_only` / `gateway_only` / Slack / Discord fields — those belong to hermes's multi-platform model, not here.
- **No config-gated commands.** No `gateway_config_gate` analog. Every command is unconditionally available.
- **No subcommand tab-completion.** Telegram has no slash-command subcommand UI; the `argsHint` is purely for help text.
- **No change to grammy's split registration model.** Pure-helper commands (`/ping`, `/start`) still register via `bot.command()`; session-affecting commands still dispatch from the `message:text` handler so they share interrupt semantics and run without a bound session. The registry just drives both lists from one source.
- **No change to `parseCommand()`.** The `@botname`-stripping parser stays as-is; the registry consumes its output.
- **No persistence of the menu.** `setMyCommands` is a fire-and-forget startup call; we do not track success or retry on failure beyond the warning log.

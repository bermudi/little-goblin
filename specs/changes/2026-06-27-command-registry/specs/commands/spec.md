# commands

## ADDED Requirements

### Requirement: Command registry is single source of truth

The system SHALL maintain a single `COMMAND_REGISTRY: readonly CommandDef[]` in `src/commands/registry.ts` as the source of truth for every slash command. Each `CommandDef` SHALL carry: canonical `name` (without leading slash), `description`, optional `aliases`, optional `argsHint`, `cancelCapable` flag, and exactly one of `handler` (a `CommandHandler` dispatched from the `message:text` path) or `grammyHandler` (a factory producing a grammy command handler registered via `bot.command()`).

Every consumer of the command set SHALL derive its data from `COMMAND_REGISTRY`:

- `HELP_REPLY` SHALL be built from each def's `name`, `argsHint`, and `description`.
- `CANCEL_CAPABLE_COMMANDS` SHALL be the set of `"/" + name` and `"/" + alias` for every def with `cancelCapable: true`.
- `registerCommands()` SHALL iterate the `grammy` defs and call `bot.command(name, grammyHandler(...))` for each.
- `handleCommand()` SHALL resolve the command token via `resolveCommand()`, run the cancel-capable cascade if the def is `cancelCapable`, and call `def.handler(...)`.
- The Telegram `setMyCommands` payload SHALL be derived from the registry.

Adding a new command SHALL require exactly one `CommandDef` entry. Adding an alias SHALL require only extending the `aliases` tuple on the existing `CommandDef`. No other file SHALL need editing for either operation (beyond the handler implementation itself for a new command).

#### Scenario: Adding a command is one entry

- **WHEN** a new slash command `/foo` is added
- **THEN** exactly one `CommandDef` entry SHALL be added to `COMMAND_REGISTRY`
- **AND** `HELP_REPLY`, `CANCEL_CAPABLE_COMMANDS` (if cancel-capable), `registerCommands()` (if grammy), `handleCommand()` dispatch, and the Telegram menu SHALL all reflect the new command without any further edits

#### Scenario: Adding an alias is one tuple edit

- **WHEN** an alias `/f` is added to an existing command `/foo`
- **THEN** only the `aliases` tuple on the `/foo` `CommandDef` SHALL change
- **AND** `resolveCommand("/f")` SHALL resolve to the `/foo` def
- **AND** `HELP_REPLY` and the Telegram menu SHALL update automatically

#### Scenario: No duplicate names or aliases

- **WHEN** `COMMAND_REGISTRY` is loaded
- **THEN** no two defs SHALL share the same `name`
- **AND** no alias SHALL collide with another def's `name` or alias
- **AND** a registry validation test SHALL fail the build on any collision

#### Scenario: Every def has exactly one handler kind

- **WHEN** `COMMAND_REGISTRY` is loaded
- **THEN** every def SHALL have exactly one of `handler` or `grammyHandler`
- **AND** a def with `cancelCapable: true` SHALL have a `handler` (not `grammyHandler`), because cancel-capable commands dispatch from the `message:text` path

#### Scenario: Resolve command by name or alias

- **WHEN** `resolveCommand("/voice")` or `resolveCommand("/v")` is called
- **THEN** both SHALL resolve to the same `CommandDef` with `name: "voice"`
- **AND** `resolveCommand("voice")` (without leading slash) SHALL also resolve to the same def
- **AND** `resolveCommand("/unknown")` SHALL return `null`

### Requirement: Telegram command menu is populated at startup

The system SHALL call `bot.api.setMyCommands()` once at startup with a `BotCommand[]` derived from `COMMAND_REGISTRY`. Each entry SHALL use a sanitized command name (lowercase, hyphens replaced with underscores, ≤32 characters, matching `^[a-z][a-z0-9_]{0,31}$`) and the def's `description` (truncated to 256 characters). Aliases SHALL be excluded — one menu entry per canonical command. The call SHALL be best-effort: on failure, the system SHALL log a warning and continue startup without aborting.

#### Scenario: Menu populated from registry

- **WHEN** the bot starts successfully
- **THEN** `setMyCommands` SHALL be called with one `BotCommand` per non-grammy def plus grammy defs
- **AND** each `BotCommand.command` SHALL be the sanitized canonical name (no aliases)
- **AND** each `BotCommand.description` SHALL be the def's description

#### Scenario: setMyCommands failure is non-fatal

- **WHEN** `setMyCommands` rejects (e.g. network error, rate limit)
- **THEN** the system SHALL log a warning with the error
- **AND** the bot SHALL continue starting and remain functional (commands still dispatch via `message:text`)

## MODIFIED Requirements

### Requirement: Register command handlers on bot

The system SHALL register command handlers in two locations, both derived from `COMMAND_REGISTRY` in `src/commands/registry.ts`: pure-helper commands (`/ping`, `/start` — defs with a `grammyHandler`) via grammy's `bot.command()` middleware in `registerCommands()`, and session-affecting commands (defs with a `handler`) inline in the `message:text` handler in `bot.ts` so they share interrupt semantics and can run even when no session is bound. `registerCommands()` SHALL iterate the `grammy` defs and call `bot.command(name, grammyHandler(...))` for each — no command name SHALL be hardcoded in `registerCommands()`.

#### Scenario: Bot initialized

- **WHEN** `registerCommands()` is called with a Bot instance and SessionManager
- **THEN** it SHALL register a `bot.command()` handler for every def in `COMMAND_REGISTRY` that has a `grammyHandler`
- **AND** session-affecting commands (defs with a `handler`) SHALL be routed by `bot.ts`'s `message:text` handler via `handleCommand()`

### Requirement: Help command lists available commands

The `/help` command SHALL reply with a list of all available commands. The reply text (`HELP_REPLY`) SHALL be derived from `COMMAND_REGISTRY` — one line per def, formatted as `/<name><args>` — `<description>` (where `<args>` is a leading space plus `argsHint` if present, otherwise empty). The reply SHALL list every command mandated by the spec.

#### Scenario: Help output

- **WHEN** `/help` is sent
- **THEN** a reply SHALL list all available commands: `/cancel`, `/new`, `/archive`, `/compact`, `/debug`, `/think`, `/model`, `/project`, `/name`, `/resume`, `/subagents`, `/cancel_subagent`, `/revive`, `/voice`, `/help`

#### Scenario: Help output includes session management commands

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/name`
- **AND** the reply SHALL include `/resume`

#### Scenario: Help output includes queue

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/queue <text>`

### Requirement: Cancel-capable command dispatch is Telegram-side-effect-free

The command dispatch in `bot.ts`'s `message:text` handler SHALL be implemented as `handleCommand(opts: DispatchOpts): Promise<DispatchResult>` exported from `src/commands/dispatch.ts`. The function SHALL resolve the command token via `resolveCommand()` from `src/commands/registry.ts`; if no def matches or the def has no `handler` (i.e. a grammy-only def), it SHALL return `{ kind: "fallthrough" }`. For cancel-capable defs, it SHALL run `interruptAndCascade` before calling `def.handler(...)`. The function may call command executors that mutate session state through `SessionManager`, but it MUST NOT mutate the grammy `Context`, MUST NOT call `bot.api.*` methods, MUST NOT receive or touch the `agentRunners` map, and MUST NOT call `runner.dispose()` on any existing runner. It returns a structured result describing the Telegram replies and runner lifecycle side effects the caller must apply.

#### Scenario: Dispatch takes deps as a parameter

- **WHEN** `handleCommand` is invoked
- **THEN** it SHALL receive a `Deps` object that includes the `manager`, `subagentRunner`, `cfg`, and a `tryResolveModel` helper
- **AND** it SHALL receive an `interruptAndCascade` reference that can be overridden in tests
- **AND** the `Deps` object SHALL be the only way the function reaches into the bot's wiring state

#### Scenario: Dispatch returns side effects, not direct mutations

- **WHEN** `handleCommand` is invoked with a cancel-capable command (e.g. `/new`, `/archive`, `/model`)
- **THEN** the returned `DispatchResult.reply` SHALL be the text to send back to the user
- **AND** the returned `DispatchResult.sideEffects` SHALL describe runner-map mutations the caller must perform (e.g. `runner-created`, `runner-disposed`)
- **AND** the function itself SHALL NOT mutate `runners`, SHALL NOT call `runner.dispose()`, and SHALL NOT send a `ctx.reply` — the caller does that

#### Scenario: Unknown command returns fallthrough

- **WHEN** `handleCommand` is invoked with a command that resolves to no def (or a grammy-only def with no `handler`)
- **THEN** the returned `DispatchResult.kind` SHALL be `"fallthrough"`
- **AND** the caller SHALL continue to normal agent routing

#### Scenario: Cascade interrupt is observable from dispatch

- **WHEN** `handleCommand` is invoked for a cancel-capable command
- **THEN** it SHALL call the injected `interruptAndCascade` with the existing runner (if any), the subagent runner, the cascade timeout, and the session id
- **AND** the cascade `CascadeResult` SHALL be available to the command handler for honest timeout reporting in the reply text

#### Scenario: Dispatch is testable in isolation

- **WHEN** a unit test constructs a `Deps` bundle with fake `manager`, fake `subagentRunner`, and a stubbed `interruptAndCascade`
- **THEN** `handleCommand` SHALL execute the dispatch logic without requiring a real grammy `Bot` instance, a real `SubagentRunner`, or any `bot.api.*` calls
- **AND** the test SHALL assert on the returned `DispatchResult` (reply text and side-effect list)

### Requirement: Cancel cascades to all live subagents

All cancel-capable commands — defined as the set of `CommandDef` entries with `cancelCapable: true` in `COMMAND_REGISTRY` — SHALL abort all live subagents in addition to the main agent. The specific command names in this set SHALL NOT be hardcoded in any spec or source file outside `COMMAND_REGISTRY`; the set is derived solely from the registry.

#### Scenario: Cancel kills parent and subagents

- **WHEN** `/cancel` is sent while goblin is streaming and subagents are running
- **THEN** all live subagents SHALL be aborted
- **AND** the main agent SHALL be aborted
- **AND** a "Cancelled" reply SHALL be sent

#### Scenario: Cancel with no subagents

- **WHEN** `/cancel` is sent while goblin is streaming with no subagents
- **THEN** only the main agent SHALL be aborted (cascade is a no-op)

#### Scenario: /new cascades before creating session

- **WHEN** `/new` is sent while subagents are running
- **THEN** all subagents SHALL be aborted before creating the new session
- **AND** no orphan subagents SHALL reference the old session

### Requirement: Commands use interrupt semantics not queue

All cancel-capable commands — defined as the set of `CommandDef` entries with `cancelCapable: true` in `COMMAND_REGISTRY` — SHALL cancel any active stream before executing. The specific command names in this set SHALL NOT be hardcoded in any spec or source file outside `COMMAND_REGISTRY`; the set is derived solely from the registry.

#### Scenario: Rapid command spam

- **WHEN** `/new` then `/archive` sent in quick succession
- **THEN** each SHALL execute immediately, cancelling prior activity
- **AND** the session SHALL be in `sessions/archive/`
- **AND** the binding SHALL be cleared
- **AND** no runner SHALL be active for that chat

### Requirement: Compact command is registered as a cancel-capable command

The `/compact` command SHALL be a cancel-capable command — i.e. its `CommandDef` in `COMMAND_REGISTRY` SHALL have `cancelCapable: true`, so it appears in the registry-derived `CANCEL_CAPABLE_COMMANDS` set and receives the same interrupt semantics as `/model`, `/debug`, `/archive`, `/new`, and `/cancel`. The set SHALL NOT be hardcoded in `bot.ts`; it is derived solely from `COMMAND_REGISTRY` in `src/commands/registry.ts`.

#### Scenario: Cancel-capable set includes /compact

- **WHEN** the bot is initialized
- **THEN** `CANCEL_CAPABLE_COMMANDS` SHALL contain `"/compact"`

### Requirement: Name and resume are cancel-capable commands

The `/name` and `/resume` commands SHALL be cancel-capable commands — i.e. their `CommandDef` entries in `COMMAND_REGISTRY` SHALL have `cancelCapable: true`, so they appear in the registry-derived `CANCEL_CAPABLE_COMMANDS` set and receive the same interrupt semantics as `/model`, `/debug`, `/archive`, `/new`, `/compact`, and `/cancel`. The set SHALL NOT be hardcoded in `bot.ts`; it is derived solely from `COMMAND_REGISTRY` in `src/commands/registry.ts`.

#### Scenario: Resume during active turn

- **WHEN** `/resume <target>` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted with cascade before the binding changes

#### Scenario: Name during active turn

- **WHEN** `/name <name>` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted with cascade before the title changes

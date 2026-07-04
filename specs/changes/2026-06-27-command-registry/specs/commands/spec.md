# commands

## ADDED Requirements

### Requirement: Command registry is single source of truth

The system SHALL maintain a single `COMMAND_REGISTRY: readonly CommandDef[]` in `src/commands/registry.ts` as the source of truth for every slash command. Each `CommandDef` SHALL carry: canonical `name` (without leading slash), `description`, optional `aliases`, optional `argsHint`, a `timing` classification, and exactly one of `handler` (a `CommandHandler` dispatched from the `message:text` path) or `grammyHandler` (a factory producing a grammy command handler registered via `bot.command()`).

Every consumer of the command set SHALL derive its data from `COMMAND_REGISTRY`:

- `HELP_REPLY` SHALL be built from each def's `name`, `argsHint`, and `description`.
- `resolveTiming()` SHALL derive instant, queue, or interrupt behavior from each def's `timing` field.
- `registerCommands()` SHALL iterate the `grammy` defs and call `bot.command(name, grammyHandler(...))` for each.
- `handleCommand()` SHALL resolve the command token via `resolveCommand()` and call `def.handler(...)` for dispatched commands.
- The Telegram `setMyCommands` payload SHALL be derived from the registry.

Adding a new command SHALL require exactly one `CommandDef` entry. Adding an alias SHALL require only extending the `aliases` tuple on the existing `CommandDef`. No other file SHALL need editing for either operation (beyond the handler implementation itself for a new command).

#### Scenario: Adding a command is one entry

- **WHEN** a new slash command `/foo` is added
- **THEN** exactly one `CommandDef` entry SHALL be added to `COMMAND_REGISTRY`
- **AND** `HELP_REPLY`, `resolveTiming()`, `registerCommands()` (if grammy), `handleCommand()` dispatch, and the Telegram menu SHALL all reflect the new command without any further edits

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
- **AND** every def SHALL declare a `timing` classification

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

The system SHALL register command handlers in two locations, both derived from `COMMAND_REGISTRY` in `src/commands/registry.ts`: pure-helper commands (`/ping`, `/start` — defs with a `grammyHandler`) via grammy's `bot.command()` middleware in `registerCommands()`, and session-affecting commands (defs with a `handler`) inline in the `message:text` handler in `bot.ts` so they share timing semantics and can run even when no session is bound. `registerCommands()` SHALL iterate the `grammy` defs and call `bot.command(name, grammyHandler(...))` for each — no command name SHALL be hardcoded in `registerCommands()`.

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

### Requirement: Command dispatch is Telegram-side-effect-free

The command dispatch in `bot.ts`'s `message:text` handler SHALL be implemented as `handleCommand(opts: DispatchOpts): Promise<DispatchResult>` exported from `src/commands/dispatch.ts`. The function SHALL resolve the command token via `resolveCommand()` from `src/commands/registry.ts`; if no def matches or the def has no `handler` (i.e. a grammy-only def), it SHALL return `{ kind: "fallthrough" }`. `/cancel` SHALL own its own interrupt cascade inside its handler; dispatch itself SHALL call `def.handler(...)` without a timing pre-check. The function may call command executors that mutate session state through `SessionManager`, but it MUST NOT mutate the grammy `Context`, MUST NOT call `bot.api.*` methods, MUST NOT receive or touch the `agentRunners` map, and MUST NOT call `runner.dispose()` on any existing runner. It returns a structured result describing the Telegram replies and runner lifecycle side effects the caller must apply.

#### Scenario: Dispatch takes deps as a parameter

- **WHEN** `handleCommand` is invoked
- **THEN** it SHALL receive a `Deps` object that includes the `manager`, `subagentRunner`, `cfg`, and a `tryResolveModel` helper
- **AND** it SHALL receive an `interruptAndCascade` reference that can be overridden in tests
- **AND** the `Deps` object SHALL be the only way the function reaches into the bot's wiring state

#### Scenario: Dispatch returns side effects, not direct mutations

- **WHEN** `handleCommand` is invoked with a dispatched command (e.g. `/new`, `/archive`, `/model`)
- **THEN** the returned `DispatchResult.reply` SHALL be the text to send back to the user
- **AND** the returned `DispatchResult.sideEffects` SHALL describe runner-map mutations the caller must perform (e.g. `runner-created`, `runner-disposed`)
- **AND** the function itself SHALL NOT mutate `runners`, SHALL NOT call `runner.dispose()`, and SHALL NOT send a `ctx.reply` — the caller does that

#### Scenario: Unknown command returns fallthrough

- **WHEN** `handleCommand` is invoked with a command that resolves to no def (or a grammy-only def with no `handler`)
- **THEN** the returned `DispatchResult.kind` SHALL be `"fallthrough"`
- **AND** the caller SHALL continue to normal agent routing

#### Scenario: Cancel owns cascade interrupt

- **WHEN** `handleCommand` is invoked for `/cancel`
- **THEN** the `/cancel` handler SHALL call the injected `interruptAndCascade` with the existing runner (if any), the subagent runner, the cascade timeout, and the session id
- **AND** the cascade `CascadeResult` SHALL be used for honest timeout reporting in the reply text

#### Scenario: Dispatch is testable in isolation

- **WHEN** a unit test constructs a `Deps` bundle with fake `manager`, fake `subagentRunner`, and a stubbed `interruptAndCascade`
- **THEN** `handleCommand` SHALL execute the dispatch logic without requiring a real grammy `Bot` instance, a real `SubagentRunner`, or any `bot.api.*` calls
- **AND** the test SHALL assert on the returned `DispatchResult` (reply text and side-effect list)

### Requirement: Cancel cascades to all live subagents

`/cancel` is the sole interrupt-timing command; it SHALL abort all live subagents in addition to the main agent. No other command cascades — state-mutating commands defer behind the turn instead of aborting.

#### Scenario: Cancel kills parent and subagents

- **WHEN** `/cancel` is sent while goblin is streaming and subagents are running
- **THEN** all live subagents SHALL be aborted
- **AND** the main agent SHALL be aborted
- **AND** a "Cancelled" reply SHALL be sent

#### Scenario: Cancel with no subagents

- **WHEN** `/cancel` is sent while goblin is streaming with no subagents
- **THEN** only the main agent SHALL be aborted (cascade is a no-op)

#### Scenario: State-mutating commands do not cascade

- **WHEN** `/new` is sent while subagents are running
- **THEN** `/new` SHALL defer behind the active turn rather than cascading cancellation
- **AND** subagents SHALL continue until they finish or the session is disposed

### Requirement: State-mutating commands queue behind the current turn

Queue-timing commands SHALL defer behind an in-flight turn rather than aborting it. If an earlier queued continuation swaps out the runner, later continuations for the stale runner SHALL be dropped by the current-runner guard. `/cancel` is the sole exception: it interrupts.

#### Scenario: Rapid command spam

- **WHEN** `/new` then `/archive` are sent in quick succession while a turn is streaming
- **THEN** each SHALL defer behind the turn (not abort it)
- **AND** once the turn settles, `/new` SHALL execute first and bind a fresh session
- **AND** `/archive` SHALL be dropped because its captured runner is no longer current
- **AND** the fresh session SHALL remain bound

### Requirement: Command timing classification

Every command in `COMMAND_REGISTRY` SHALL declare when it runs relative to an in-flight turn: `instant`, `queue`, or `interrupt`. `/compact` SHALL be queue-timing, so it defers behind an active turn instead of aborting it.

#### Scenario: Compact is queue-timing

- **WHEN** the bot is initialized
- **THEN** `/compact` SHALL resolve to queue timing

### Requirement: Name and resume use the timing classification

The `/name` command SHALL be instant-timing: it runs immediately regardless of streaming state and does not abort or defer the turn. The `/resume` command SHALL be queue-timing: if a turn is in flight, it defers behind it so the old session's transcript is complete and the runner is idle before the binding changes.

#### Scenario: Resume during active turn

- **WHEN** `/resume <target>` is sent while the agent is streaming
- **THEN** the command SHALL be deferred behind the current turn (not aborted)
- **AND** the binding SHALL change once the turn settles

#### Scenario: Name during active turn

- **WHEN** `/name <name>` is sent while the agent is streaming
- **THEN** the title SHALL be set immediately (instant-timing)
- **AND** the running turn SHALL NOT be aborted or deferred

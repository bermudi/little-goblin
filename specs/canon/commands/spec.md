# commands

## Requirements

### Requirement: Register command handlers on bot

The system SHALL register command handlers in two locations: pure-helper commands (`/ping`, `/start`) via grammy's `bot.command()` middleware in `registerCommands()`, and session-affecting commands (`/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent`, `/revive`, `/help`) inline in the `message:text` handler in `bot.ts` so they share interrupt semantics and can run even when no session is bound.

#### Scenario: Bot initialized

- **WHEN** `registerCommands()` is called with a Bot instance and SessionManager
- **THEN** it SHALL register handlers for `/ping` and `/start` only
- **AND** session-affecting commands SHALL be routed by `bot.ts`'s `message:text` handler

### Requirement: Implement /ping command

The system SHALL provide a `/ping` command that responds with user and chat information.

#### Scenario: /ping in DM

- **WHEN** a user sends `/ping` in a private chat
- **THEN** the bot SHALL reply with: `pong 🐲\nuser: <userId>\nchat: private`

#### Scenario: /ping in topic

- **WHEN** a user sends `/ping` in a forum topic
- **THEN** the bot SHALL reply with: `pong 🐲\nuser: <userId>\nchat: <type>\ntopic: <topicId>`
- **AND** the reply SHALL be sent to the correct topic thread

### Requirement: Implement /start command for DM session creation

The system SHALL provide a `/start` command that creates a new session in private chats and welcomes the user.

#### Scenario: /start in private chat

- **WHEN** a user sends `/start` in a private chat (DM)
- **THEN** the bot SHALL create a new session via `SessionManager.createForChat()`
- **AND** reply with a welcome message that includes the session ID

### Requirement: Reject /start in non-forum groups

The system SHALL reject `/start` in plain group chats that are not forums.

#### Scenario: /start in plain group

- **WHEN** a user sends `/start` in a non-private, non-topic chat (e.g., basic group)
- **THEN** the bot SHALL reply with: `Use /start in a private chat or a forum topic.`

### Requirement: Handle /start in forum topic

The system SHALL inform users that topics are already sessions when `/start` is used in a topic.

#### Scenario: /start in forum topic

- **WHEN** a user sends `/start` in a forum topic
- **THEN** the bot SHALL reply with: `This topic is already its own session. Just start typing!`

### Requirement: Handle indeterminate chat context for /start

The system SHALL handle cases where chat context cannot be determined for `/start`.

#### Scenario: /start with no locator

- **WHEN** `locatorFromCtx()` returns `null` for a `/start` command
- **THEN** the bot SHALL reply with: `Unable to determine chat context.`

### Requirement: Cancel command aborts current turn immediately

The `/cancel` command SHALL call `AgentRunner.abort()` immediately, cancelling any in-flight streaming or tool execution.

#### Scenario: Cancel during streaming

- **WHEN** `/cancel` is sent while goblin is streaming
- **THEN** `runner.abort()` SHALL be called
- **AND** a "Cancelled" reply SHALL be sent

#### Scenario: Cancel when idle

- **WHEN** `/cancel` is sent while goblin is idle
- **THEN** it SHALL succeed without error
- **AND** a "Nothing to cancel" reply SHALL be sent

#### Scenario: Cancel with no active session

- **WHEN** `/cancel` is sent in a DM with no active session
- **THEN** a "Nothing to cancel" reply SHALL be sent

### Requirement: New command resets the chat to a fresh session

The `/new` command SHALL cancel any active turn, archive the chat's current session if one exists, create a fresh session bound to the same chat surface (DM, forum topic, or supergroup), and switch to it. The forum topic title MUST NOT be modified — the topic surface is user-owned per decision `topic-ui-is-user-owned` (0002).

#### Scenario: New during active turn

- **WHEN** `/new` is sent while streaming
- **THEN** the current turn SHALL be aborted (with cascade to subagents)
- **AND** the existing session SHALL be archived
- **AND** a new session SHALL be created and bound to the same chat surface
- **AND** a reply SHALL include the new session ID

#### Scenario: New when idle with prior session

- **WHEN** `/new` is sent while idle and a session is already bound to the chat
- **THEN** the existing session SHALL be archived without abort
- **AND** a new session SHALL be created and bound to the same chat surface
- **AND** a reply SHALL include the new session ID

#### Scenario: New in a forum topic

- **WHEN** `/new` is sent in a forum topic
- **THEN** the active turn SHALL be aborted (if streaming, with cascade to subagents)
- **AND** the topic's existing session SHALL be archived
- **AND** a fresh session SHALL be created and bound to the same `(chat, topic)`
- **AND** the topic title MUST NOT be modified
- **AND** a reply SHALL include the new session ID

#### Scenario: New with no active session

- **WHEN** `/new` is sent in a DM with no active session
- **THEN** a new session SHALL be created (no archive step, since there is nothing to archive)
- **AND** a reply SHALL include the new session ID

### Requirement: Archive command cancels and archives session

The `/archive` command SHALL cancel any active turn, move the current session to `sessions/archive/`, and clear the binding. The forum topic surface MUST NOT be mutated (no rename, no close, no icon change) — the topic is user-owned per decision `topic-ui-is-user-owned` (0002).

#### Scenario: Archive during streaming

- **WHEN** `/archive` is sent while streaming
- **THEN** the current turn SHALL be aborted (with cascade to subagents)
- **AND** the session SHALL be archived

#### Scenario: Archive in topic does not mutate topic UI

- **WHEN** `/archive` is used in a forum topic
- **THEN** the session SHALL be moved to archive
- **AND** the binding SHALL be cleared
- **AND** the topic name, status (open/closed), and icon MUST NOT be changed
- **AND** the next user message in the same topic SHALL auto-create a fresh session bound to the same `(chat, topic)`

#### Scenario: Already archived session

- **WHEN** `/archive` is used on an already-archived session
- **THEN** detection SHALL check if `sessions/<id>/` exists; if not, "Session already archived" SHALL be shown

#### Scenario: Archive with no active session

- **WHEN** `/archive` is sent in a DM with no active session
- **THEN** a "No active session to archive" reply SHALL be sent

### Requirement: Debug command cancels and dumps diagnostics

The `/debug` command SHALL include the session name in its diagnostics output. `gatherDiagnostics` SHALL extract `deps.session.title ?? null` into a new `sessionName` field on the `Diagnostics` type. `formatDiagnostics` SHALL render `Session Name: <name>` immediately after `Session: <id>` when the name is present, and `Session Name: unavailable` when absent.

#### Scenario: Named session

- **WHEN** `/debug` is invoked on a session with `title: "ttt-v2"`
- **THEN** the output SHALL contain `Session: <id>` followed by `Session Name: ttt-v2`

#### Scenario: Unnamed session

- **WHEN** `/debug` is invoked on a session with no `title`
- **THEN** the output SHALL contain `Session Name: unavailable`

### Requirement: Subagents command surface exists (stub)

The `/subagents` command SHALL exist and reply with a stub message. Full implementation is in `subagent-runtime` change.

#### Scenario: Subagents stub

- **WHEN** `/subagents` is sent
- **THEN** a stub reply "Not implemented" SHALL be shown

### Requirement: Cancel subagent command surface exists (stub)

The `/cancel_subagent <id>` command SHALL exist and reply with a stub message. Full implementation is in `subagent-runtime` change.

#### Scenario: Cancel subagent stub

- **WHEN** `/cancel_subagent abc123` is sent
- **THEN** a stub reply "Not implemented" SHALL be shown

### Requirement: Revive command surface exists (stub)

The `/revive <id>` command SHALL exist and reply with a stub message. Full implementation is in `subagent-runtime` change.

#### Scenario: Revive stub

- **WHEN** `/revive abc123` is sent
- **THEN** a stub reply "Not implemented" SHALL be shown

### Requirement: Cancel cascades to all live subagents

All cancel-capable commands (`/cancel`, `/new`, `/archive`, `/debug`) SHALL abort all live subagents in addition to the main agent.

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

All session-affecting commands (`/new`, `/archive`, `/debug`) SHALL cancel any active stream before executing.

#### Scenario: Rapid command spam

- **WHEN** `/new` then `/archive` sent in quick succession
- **THEN** each SHALL execute immediately, cancelling prior activity
- **AND** the session SHALL be in `sessions/archive/`
- **AND** the binding SHALL be cleared
- **AND** no runner SHALL be active for that chat

### Requirement: Cascade cancel is bounded by a timeout

The cascade SHALL bound each individual `abort()`/`cancel()` call by a per-call timeout (default 5 seconds). A target whose abort does not resolve within the timeout SHALL be left alone (no kill-9 fallback per non-goal) but SHALL be reported in the cascade summary so the user-facing reply is honest about what may still be running.

#### Scenario: Stuck subagent does not block the command

- **WHEN** `/cancel` is sent and a subagent's `cancel()` never resolves
- **THEN** the cascade SHALL stop waiting on that subagent after the timeout
- **AND** the command SHALL still complete and reply within bounded time
- **AND** the reply SHALL acknowledge the timed-out subagent (e.g. "Cancelled. (1 subagent didn't respond in 5s and may still be running.)")

#### Scenario: Stuck main agent does not block the command

- **WHEN** `/cancel` is sent and the main runner's `abort()` never resolves
- **THEN** the cascade SHALL stop waiting on the main runner after the timeout
- **AND** subagent cancels SHALL still run after the main timeout
- **AND** the reply SHALL acknowledge the stuck main agent

### Requirement: Help command lists available commands

The `/help` command SHALL reply with a list of all available commands.

#### Scenario: Help output

- **WHEN** `/help` is sent
- **THEN** a reply SHALL list all available commands: `/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent`, `/revive`, `/help`

### Requirement: Name command persists bound session title

The `/name <name>` command SHALL cancel any active turn, require a bound session, and persist the provided name as the bound session's `SessionState.title`.

If no session is bound to the chat, the reply SHALL be "No active session to name."

If no name is provided, the reply SHALL be "Usage: /name <session name>".

#### Scenario: Name bound session

- **WHEN** `/name memory refactor` is sent in a chat with a bound session
- **THEN** the bound session's `title` SHALL be set to `"memory refactor"`
- **AND** the reply SHALL include the session ID and title

#### Scenario: Name with no bound session

- **WHEN** `/name memory refactor` is sent in a DM with no bound session
- **THEN** the reply SHALL say `"No active session to name."`

#### Scenario: Name without argument

- **WHEN** `/name` is sent
- **THEN** the reply SHALL show usage

### Requirement: Resume command binds chat to an existing resumable session

The `/resume <id-or-name>` command SHALL cancel any active turn, find an existing resumable session by exact ID, unique ID prefix, or exact title, and bind the current Telegram surface to that session.

The command SHALL NOT archive, delete, or mutate the previously bound session. If switching away from an in-memory runner, the old runner SHALL be disposed so future messages use the resumed session's runner.

If no target is provided, the reply SHALL list named resumable sessions. Anonymous sessions SHALL be omitted from this listing.

If no session matches, the reply SHALL report that no session was found for the target.

If multiple sessions match, the reply SHALL report the ambiguity and list matching session IDs and titles.

Archived sessions under `sessions/archive/` SHALL NOT be considered by `/resume`.

#### Scenario: Resume by exact session ID

- **WHEN** `/resume abc123def0` is sent
- **AND** a resumable session with ID `abc123def0` exists
- **THEN** the current chat surface SHALL be bound to `abc123def0`
- **AND** the reply SHALL include the resumed session ID

#### Scenario: Resume by ID prefix

- **WHEN** `/resume abc123` is sent
- **AND** exactly one resumable session ID starts with `abc123`
- **THEN** the current chat surface SHALL be bound to that session

#### Scenario: Resume by exact title

- **WHEN** `/resume memory refactor` is sent
- **AND** exactly one resumable session has title `"memory refactor"`
- **THEN** the current chat surface SHALL be bound to that session

#### Scenario: Resume ambiguous target

- **WHEN** `/resume abc` is sent
- **AND** more than one resumable session ID starts with `abc`
- **THEN** the command SHALL NOT change the current binding
- **AND** the reply SHALL list matching sessions

#### Scenario: Resume named prior session after new

- **WHEN** `/name ttt` is sent in a chat with a bound session
- **AND** `/new` is sent in the same chat
- **AND** `/resume ttt` is sent in the same chat
- **THEN** the chat surface SHALL be rebound to the session named `ttt`
- **AND** the session created by `/new` SHALL remain under `sessions/<id>/` as a resumable unbound session

#### Scenario: Archived sessions are not resumed

- **WHEN** `/archive` is used on a session named `ttt`
- **AND** `/resume ttt` is sent
- **THEN** `/resume` SHALL NOT find that archived session

#### Scenario: Resume without argument lists named sessions

- **WHEN** `/resume` is sent
- **AND** at least one resumable session has a title
- **THEN** the reply SHALL list named resumable sessions with their IDs and titles
- **AND** unnamed sessions SHALL be omitted

#### Scenario: Resume without argument and no named sessions

- **WHEN** `/resume` is sent
- **AND** no resumable session has a title
- **THEN** the reply SHALL say no named sessions exist yet

### Requirement: Name and resume are cancel-capable commands

The `/name` and `/resume` commands SHALL be added to the cancel-capable command set in `bot.ts`, giving them the same interrupt semantics as `/model`, `/debug`, `/archive`, `/new`, `/compact`, and `/cancel`.

#### Scenario: Resume during active turn

- **WHEN** `/resume <target>` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted with cascade before the binding changes

#### Scenario: Name during active turn

- **WHEN** `/name <name>` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted with cascade before the title changes

### Requirement: Help command lists name and resume

The `/help` command SHALL list `/name <name>` and `/resume <id-or-name>` in the available command list.

#### Scenario: Help output includes session management commands

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/name`
- **AND** the reply SHALL include `/resume`

### Requirement: New command creates a fresh resumable session

The `/new` command SHALL create a fresh session bound to the same chat surface. If the chat surface previously had a bound session, that previous session SHALL remain resumable.

#### Scenario: New with prior bound session

- **WHEN** `/new` is sent while a session is bound to the chat
- **THEN** a new session SHALL be created and bound to the same chat surface
- **AND** the previously bound session SHALL remain under `sessions/<old-id>/`
- **AND** the previously bound session SHALL be included in resume lookup

#### Scenario: New in a forum topic

- **WHEN** `/new` is sent in a forum topic
- **THEN** a fresh session SHALL be created and bound to the same `(chat, topic)`
- **AND** the previous topic session SHALL remain resumable

### Requirement: Compact command triggers manual context compaction

The `/compact` command SHALL cancel any active turn (cancel-capable, same semantics as `/model` and `/debug`), invoke `AgentRunner.compact()`, and reply with the result. Optional trailing text SHALL be forwarded as `customInstructions` to pi's compaction (e.g. `/compact focus on the database schema decisions`).

If no session is bound to the chat, the reply SHALL be "No active session to compact."

If the session exists but has nothing to compact (pi throws), the reply SHALL include the error message from pi (e.g. "Nothing to compact (session too small).").

If compaction succeeds, the reply SHALL include `tokensBefore` from the result (formatted as e.g. `"Compacted from ~42K tokens."`).

#### Scenario: Compact an active session

- **WHEN** `/compact` is sent in a chat with an active session that has multiple turns of history
- **AND** the agent is idle (not streaming)
- **THEN** `runner.compact()` SHALL be called
- **AND** a reply SHALL include the tokens-freed count (e.g. `"Compacted from ~42K tokens."`)

#### Scenario: Compact during active turn

- **WHEN** `/compact` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted (with cascade to subagents)
- **AND** `runner.compact()` SHALL be called after the abort completes
- **AND** a reply SHALL be sent with the compaction result

#### Scenario: Compact with custom instructions

- **WHEN** `/compact focus on the schema decisions` is sent
- **THEN** `runner.compact("focus on the schema decisions")` SHALL be called

#### Scenario: Nothing to compact

- **WHEN** `/compact` is sent and the session has minimal history
- **THEN** a reply SHALL indicate the session is too small to compact (pi's error message)

#### Scenario: No active session

- **WHEN** `/compact` is sent in a DM with no active session
- **THEN** a reply SHALL say `"No active session to compact."`

### Requirement: Compact command is registered as a cancel-capable command

The `/compact` command SHALL be added to the `CANCEL_CAPABLE_COMMANDS` set in `bot.ts`, giving it the same interrupt semantics as `/model`, `/debug`, `/archive`, `/new`, and `/cancel`.

#### Scenario: Cancel-capable set includes /compact

- **WHEN** the bot is initialized
- **THEN** `CANCEL_CAPABLE_COMMANDS` SHALL contain `"/compact"`

### Requirement: Cancel-capable command dispatch is Telegram-side-effect-free

The cancel-capable command switch in `bot.ts`'s `message:text` handler SHALL be implemented as `handleCancelCapableCommand(opts: DispatchOpts): Promise<DispatchResult>` exported from `src/commands/dispatch.ts`. The function may call command executors that mutate session state through `SessionManager`, but it MUST NOT mutate the grammy `Context`, MUST NOT call `bot.api.*` methods, MUST NOT receive or touch the `agentRunners` map, and MUST NOT call `runner.dispose()` on any existing runner. It returns a structured result describing the Telegram replies and runner lifecycle side effects the caller must apply.

#### Scenario: Dispatch takes deps as a parameter

- **WHEN** `handleCancelCapableCommand` is invoked
- **THEN** it SHALL receive a `Deps` object that includes the `manager`, `subagentRunner`, `cfg`, and a `tryResolveModel` helper
- **AND** it SHALL receive an `interruptAndCascade` reference that can be overridden in tests
- **AND** the `Deps` object SHALL be the only way the function reaches into the bot's wiring state

#### Scenario: Dispatch returns side effects, not direct mutations

- **WHEN** `handleCancelCapableCommand` is invoked with a cancel-capable command (e.g. `/new`, `/archive`, `/model`)
- **THEN** the returned `DispatchResult.reply` SHALL be the text to send back to the user
- **AND** the returned `DispatchResult.sideEffects` SHALL describe runner-map mutations the caller must perform (e.g. `runner-created`, `runner-disposed`)
- **AND** the function itself SHALL NOT mutate `runners`, SHALL NOT call `runner.dispose()`, and SHALL NOT send a `ctx.reply` — the caller does that

#### Scenario: Unknown command returns fallthrough

- **WHEN** `handleCancelCapableCommand` is invoked with a command that is not in its switch
- **THEN** the returned `DispatchResult.kind` SHALL be `"fallthrough"`
- **AND** the caller SHALL continue to normal agent routing

#### Scenario: Cascade interrupt is observable from dispatch

- **WHEN** `handleCancelCapableCommand` is invoked for a cancel-capable command
- **THEN** it SHALL call the injected `interruptAndCascade` with the existing runner (if any), the subagent runner, the cascade timeout, and the session id
- **AND** the cascade `CascadeResult` SHALL be available to the command executor for honest timeout reporting in the reply text

#### Scenario: Dispatch is testable in isolation

- **WHEN** a unit test constructs a `Deps` bundle with fake `manager`, fake `subagentRunner`, and a stubbed `interruptAndCascade`
- **THEN** `handleCancelCapableCommand` SHALL execute the dispatch logic without requiring a real grammy `Bot` instance, a real `SubagentRunner`, or any `bot.api.*` calls
- **AND** the test SHALL assert on the returned `DispatchResult` (reply text and side-effect list)

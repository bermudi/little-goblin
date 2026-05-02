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

The `/debug` command SHALL cancel any active turn and dump session diagnostics (loaded skills, active tools, model, context usage).

#### Scenario: Debug during streaming

- **WHEN** `/debug` is sent while streaming
- **THEN** the current turn SHALL be aborted (with cascade to subagents)
- **AND** diagnostics SHALL be sent as a formatted message

#### Scenario: Debug output format

- **WHEN** `/debug` is used
- **THEN** output SHALL include: current model, active tools, events.jsonl path, session stats
- **AND** output MAY include: loaded skills, context token usage (on a best-effort basis; shown as "unavailable" if not exposed by the API)

#### Scenario: Debug with no active session

- **WHEN** `/debug` is sent in a DM with no active session
- **THEN** a "No active session" reply SHALL be sent

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

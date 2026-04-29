# commands

## ADDED Requirements

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

### Requirement: New command cancels and creates fresh session

The `/new` command SHALL cancel any active turn, create a new DM session, and switch to it.

#### Scenario: New during active turn
- **WHEN** `/new` is sent while streaming
- **THEN** the current turn SHALL be aborted (with cascade to subagents)
- **AND** a new session SHALL be created
- **AND** a reply SHALL include the new session ID
- **AND** the chat binding SHALL reference the new session ID

#### Scenario: New when idle
- **WHEN** `/new` is sent while idle
- **THEN** a new session SHALL be created without abort
- **AND** a reply SHALL include the new session ID

#### Scenario: New in a forum topic
- **WHEN** `/new` is sent in a forum topic (while streaming or idle)
- **THEN** the active turn SHALL be aborted (if streaming)
- **AND** a reply SHALL state "This topic is already its own session. No need for /new here."
- **AND** no new session SHALL be created

#### Scenario: New with no active session
- **WHEN** `/new` is sent in a DM with no active session
- **THEN** a new session SHALL be created
- **AND** a reply SHALL include the new session ID

### Requirement: Archive command cancels and archives session

The `/archive` command SHALL cancel any active turn, move the current session to `sessions/archive/`, and clear the binding.

#### Scenario: Archive during streaming
- **WHEN** `/archive` is sent while streaming
- **THEN** the current turn SHALL be aborted (with cascade to subagents)
- **AND** the session SHALL be archived

#### Scenario: Archive in topic
- **WHEN** `/archive` is used in a forum topic
- **THEN** the topic SHALL be renamed to format "Archived: <topic_name>"
- **AND** the session SHALL be moved to archive

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

## MODIFIED Requirements

### Requirement: Register command handlers on bot

The system SHALL register command handlers in two locations: pure-helper commands (`/ping`, `/start`) via grammy's `bot.command()` middleware in `registerCommands()`, and session-affecting commands (`/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent`, `/revive`, `/help`) inline in the `message:text` handler in `bot.ts` so they share interrupt semantics and can run even when no session is bound.

#### Scenario: Bot initialized

- **WHEN** `registerCommands()` is called with a Bot instance and SessionManager
- **THEN** it SHALL register handlers for `/ping` and `/start` only
- **AND** session-affecting commands SHALL be routed by `bot.ts`'s `message:text` handler

## REMOVED Requirements

### Requirement: Implement /new command for DM session creation

**Reason:** Replaced by **New command cancels and creates fresh session**. The old reply format (`Created new session \`<id>\`\nWorkdir: \`sessions/<id>/workdir\`` with MarkdownV2) is superseded by the simpler `Created new session \`<id>\`` reply, because `/new` no longer guarantees session creation in every chat type and the workdir is now exposed via `/debug`.

### Requirement: Reject /new in non-forum groups

**Reason:** `/new` is now routed through `bot.ts`'s `message:text` handler. Plain groups never reach this handler because `locatorFromCtx` only emits a locator for chats with a usable id, the allowlist middleware drops non-allowed senders, and supergroup-without-topic is now an explicit supported surface (rebinds the supergroup slot). Plain-group rejection is no longer a meaningful contract.

### Requirement: Warn when /new used in topic

**Reason:** Absorbed into **New command cancels and creates fresh session** → scenario *New in a forum topic*. The reply text is preserved verbatim (`This topic is already its own session. No need for /new here.`); the new requirement adds the cancel-with-cascade semantics.

### Requirement: Handle indeterminate chat context gracefully

**Reason:** `/new` is no longer eligible to receive a null locator: the `message:text` handler returns early when `locatorFromCtx` yields `null` (logged but no reply). The `Unable to determine chat context.` reply only applies to commands that hit grammy's `bot.command()` path (still kept by `/start`).

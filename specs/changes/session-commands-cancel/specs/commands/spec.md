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

### Requirement: New command cancels and creates fresh session

The `/new` command SHALL cancel any active turn, create a new DM session, and switch to it.

#### Scenario: New during active turn
- **WHEN** `/new` is sent while streaming
- **THEN** the current turn SHALL be aborted
- **AND** a new session SHALL be created
- **AND** goblin SHALL reply from the new session

#### Scenario: New when idle
- **WHEN** `/new` is sent while idle
- **THEN** a new session SHALL be created without abort

### Requirement: Archive command cancels and archives session

The `/archive` command SHALL cancel any active turn, move the current session to `sessions/archive/`, and clear the binding.

#### Scenario: Archive during streaming
- **WHEN** `/archive` is sent while streaming
- **THEN** the current turn SHALL be aborted
- **AND** the session SHALL be archived

#### Scenario: Archive in topic
- **WHEN** `/archive` is used in a forum topic
- **THEN** the topic SHALL be renamed to format "Archived: <topic_name>"
- **AND** the session SHALL be moved to archive

#### Scenario: Already archived session
- **WHEN** `/archive` is used on an already-archived session
- **THEN** an error "Session already archived" SHALL be shown

### Requirement: Debug command cancels and dumps diagnostics

The `/debug` command SHALL cancel any active turn and dump session diagnostics (loaded skills, active tools, model, context usage).

#### Scenario: Debug during streaming
- **WHEN** `/debug` is sent while streaming
- **THEN** the current turn SHALL be aborted
- **AND** diagnostics SHALL be sent as a formatted message

#### Scenario: Debug output format
- **WHEN** `/debug` is used
- **THEN** output SHALL include: current model, active tools, loaded skills, events.jsonl path, session stats

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

### Requirement: Commands use interrupt semantics not queue

All session-affecting commands (`/new`, `/archive`, `/debug`) SHALL cancel any active stream before executing.

#### Scenario: Rapid command spam
- **WHEN** `/new` then `/archive` sent in quick succession
- **THEN** each SHALL execute immediately, cancelling prior activity
- **AND** final state SHALL reflect the last command

# commands

## ADDED Requirements

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

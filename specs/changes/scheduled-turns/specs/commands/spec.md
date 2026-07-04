# commands

## ADDED Requirements

### Requirement: Schedule command manages explicit scheduled turns

The `/schedule` command SHALL manage explicit scheduled turns for the active session. It SHALL support `list`, `at`, `every`, `remove`, `pause`, and `resume` subcommands. Creating or mutating schedules SHALL require an active session. The command SHALL be instant-timing because it only mutates the schedule store and does not touch the in-flight runner.

#### Scenario: Schedule one-shot prompt

- **WHEN** `/schedule at 2026-07-05T09:00:00Z check the backup status` is sent in a chat with an active session
- **THEN** Goblin SHALL create an enabled one-shot schedule for that session
- **AND** the reply SHALL include the schedule id and next run time

#### Scenario: Schedule recurring prompt

- **WHEN** `/schedule every 2h check the backup status` is sent in a chat with an active session
- **THEN** Goblin SHALL create an enabled recurring schedule with a two-hour interval
- **AND** the reply SHALL include the schedule id and interval

#### Scenario: List schedules

- **WHEN** `/schedule list` is sent in a chat with schedules for the active session
- **THEN** Goblin SHALL reply with all schedules for the current session, including enabled, disabled, and completed ones
- **AND** each entry SHALL include id, state, next run time (or "completed" for one-shot schedules that ran), recurrence, and a prompt preview

#### Scenario: Remove schedule

- **WHEN** `/schedule remove abc123` is sent
- **THEN** Goblin SHALL remove the matching schedule if it belongs to the active session
- **AND** reply with a confirmation

#### Scenario: Pause and resume schedule

- **WHEN** `/schedule pause abc123` then `/schedule resume abc123` are sent for a schedule in the active session
- **THEN** the first command SHALL disable the schedule
- **AND** the second command SHALL re-enable it without changing its prompt text

#### Scenario: Mutation of non-existent schedule

- **WHEN** `/schedule remove nope99` or `/schedule pause nope99` is sent and no schedule with that id belongs to the active session
- **THEN** Goblin SHALL reply that no matching schedule was found
- **AND** SHALL NOT modify any schedule

#### Scenario: Mutation of schedule owned by another session

- **WHEN** `/schedule remove abc123` is sent and schedule `abc123` exists but belongs to a different session
- **THEN** Goblin SHALL reply that no matching schedule was found
- **AND** SHALL NOT modify the schedule

#### Scenario: Schedule requires active session

- **WHEN** `/schedule list` or `/schedule every 1h hello` is sent in a DM with no active session
- **THEN** Goblin SHALL reply `No active session. Use /new to start one.`

### Requirement: Schedule command parses bounded time expressions

The `/schedule` command SHALL accept a small documented set of time expressions: absolute ISO-8601 timestamps for `at`, `in <duration>` for one-shot relative schedules, and duration strings for `every`. Durations SHALL accept integer values with units `m`, `h`, or `d`. Invalid or past times SHALL produce a usage reply and SHALL NOT create a schedule.

#### Scenario: Relative one-shot schedule

- **WHEN** `/schedule in 30m stretch your legs` is sent
- **THEN** Goblin SHALL create a one-shot schedule due approximately 30 minutes after command handling

#### Scenario: Invalid duration rejected

- **WHEN** `/schedule every soon check backups` is sent
- **THEN** Goblin SHALL reply with usage information
- **AND** SHALL NOT create a schedule

#### Scenario: Past absolute time rejected

- **WHEN** `/schedule at 2000-01-01T00:00:00Z check backups` is sent
- **THEN** Goblin SHALL reject the schedule as being in the past

### Requirement: Schedule command manages heartbeat

The `/schedule heartbeat` subcommand SHALL manage the explicit heartbeat schedule for the active session. It SHALL support `on [duration]`, `off`, and `status`. Heartbeat SHALL be disabled by default and SHALL use a 30-minute interval when enabled without a duration.

#### Scenario: Enable heartbeat with default interval

- **WHEN** `/schedule heartbeat on` is sent in a chat with an active session
- **THEN** Goblin SHALL create or enable the session's heartbeat schedule with a 30-minute interval
- **AND** reply with the heartbeat status

#### Scenario: Enable heartbeat with custom interval

- **WHEN** `/schedule heartbeat on 2h` is sent
- **THEN** Goblin SHALL create or update the session's heartbeat interval to two hours

#### Scenario: Bare heartbeat on resets to default interval

- **GIVEN** heartbeat is enabled with a 2h interval
- **WHEN** `/schedule heartbeat on` is sent (no interval argument)
- **THEN** Goblin SHALL reset the session's heartbeat interval to 30 minutes

#### Scenario: Disable heartbeat

- **WHEN** `/schedule heartbeat off` is sent
- **THEN** Goblin SHALL disable the session's heartbeat schedule
- **AND** SHALL reply confirming heartbeat is disabled

#### Scenario: Heartbeat status

- **WHEN** `/schedule heartbeat status` is sent
- **THEN** Goblin SHALL reply whether heartbeat is enabled, its interval, and its next run time when enabled

## MODIFIED Requirements

### Requirement: Help command lists available commands

The `/help` command SHALL reply with a list of all available commands. The reply text (`HELP_REPLY`) SHALL be derived from `COMMAND_REGISTRY` — one line per def, formatted as `/<name><args>` — `<description>` (where `<args>` is a leading space plus `argsHint` if present, otherwise empty). The reply SHALL list every command mandated by the spec.

#### Scenario: Help output includes schedule

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/schedule <subcommand>`

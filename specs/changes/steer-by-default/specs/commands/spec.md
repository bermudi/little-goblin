# commands

## ADDED Requirements

### Requirement: Queue command enqueues text for the next idle turn

The `/queue <text>` command SHALL enqueue the supplied text via the per-session promise queue so it runs as a fresh turn via `AgentRunner.prompt()` only after the current turn (and any prior queued work) settles. It SHALL NOT abort the running turn. It is NOT a cancel-capable command.

If no `<text>` is supplied, the reply SHALL be `"Usage: /queue <text>"` and nothing SHALL be enqueued.

If no session is bound to the chat, the reply SHALL be `"No active session."` and nothing SHALL be enqueued.

If the runner is idle when `/queue` is handled, the supplied text SHALL run immediately as a fresh turn (the queue is empty, so the work starts now).

#### Scenario: Queue behind a running turn

- **WHEN** `/queue then check the tests` is sent while goblin is streaming
- **THEN** the text `"then check the tests"` SHALL be enqueued via the per-session promise queue
- **AND** the running turn SHALL NOT be aborted
- **AND** a reply SHALL acknowledge the queue (e.g. `"Queued. Will run after the current turn."`)

#### Scenario: Queue when idle runs immediately

- **WHEN** `/queue then check the tests` is sent while goblin is idle
- **THEN** the text SHALL run as a fresh turn immediately via `AgentRunner.prompt()`
- **AND** the reply SHALL be `"Running."` (the turn starts now, not queued behind anything)

#### Scenario: Queue without text

- **WHEN** `/queue` is sent without a trailing argument
- **THEN** the reply SHALL be `"Usage: /queue <text>"`
- **AND** nothing SHALL be enqueued

#### Scenario: Queue with no active session

- **WHEN** `/queue do something` is sent in a DM with no active session
- **THEN** the reply SHALL be `"No active session."`
- **AND** nothing SHALL be enqueued

### Requirement: Queue command is not cancel-capable

The `/queue` command SHALL NOT be a member of `CANCEL_CAPABLE_COMMANDS`. It SHALL NOT abort the running turn or cascade to subagents. It appends to the per-session queue behind the running turn, it does not interrupt it.

#### Scenario: Queue does not abort a running turn

- **GIVEN** an active session whose runner is streaming
- **WHEN** `/queue do this after` is sent
- **THEN** `interruptAndCascade` SHALL NOT be invoked
- **AND** `runner.abort()` SHALL NOT be called
- **AND** the running turn SHALL continue

### Requirement: Help command lists queue

The `/help` command SHALL list `/queue <text>` in the available command list.

#### Scenario: Help output includes queue

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/queue <text>`

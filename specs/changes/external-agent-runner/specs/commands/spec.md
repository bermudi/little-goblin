# commands

## MODIFIED Requirements

### Requirement: Cancel command aborts current turn immediately

`/cancel` is the sole interrupt-timing command. It SHALL call `interruptAndCascade` itself (not via a dispatch pre-check), which calls `AgentRunner.abort()`, cascades to live pi subagents, and cancels non-terminal external-agent runs owned by the active Goblin session. Its reply SHALL be computed from the expanded cascade result for honest reporting.

#### Scenario: Cancel during streaming

- **WHEN** `/cancel` is sent while Goblin is streaming
- **THEN** `runner.abort()` SHALL be called via `interruptAndCascade`
- **AND** live pi subagents belonging to the session SHALL be aborted
- **AND** non-terminal external-agent runs owned by the session SHALL be cancelled
- **AND** a `Cancelled` reply SHALL be sent

#### Scenario: Cancel when main agent is idle but external work is running

- **WHEN** `/cancel` is sent while Goblin is idle
- **AND** the active session owns a running external-agent run
- **THEN** that external-agent run SHALL be cancelled
- **AND** a `Cancelled` reply SHALL be sent rather than `Nothing to cancel`

#### Scenario: Cancel when nothing is active

- **WHEN** `/cancel` is sent while the main agent is idle
- **AND** the active session owns no running subagent or external-agent run
- **THEN** it SHALL succeed without error
- **AND** a `Nothing to cancel` reply SHALL be sent

#### Scenario: Cancel with no active session

- **WHEN** `/cancel` is sent in a DM with no active session
- **THEN** a `Nothing to cancel` reply SHALL be sent

### Requirement: Cancel cascades to all live subagents

`/cancel` is the sole interrupt-timing command; it SHALL abort the main agent, every live pi subagent in the active session's spawn tree, and every non-terminal external-agent run owned by that session. State-mutating queue-timing commands SHALL defer behind the turn instead of invoking the interrupt cascade; when they later dispose the old session runner, disposal SHALL clean up remaining delegated work through the orchestration lifecycle.

#### Scenario: Cancel kills main agent and delegated work

- **WHEN** `/cancel` is sent while Goblin is streaming
- **AND** the active session owns running pi subagents and external-agent runs
- **THEN** all such delegated work SHALL be cancelled
- **AND** the main agent SHALL be aborted
- **AND** a `Cancelled` reply SHALL be sent

#### Scenario: Cancel with only external work

- **WHEN** `/cancel` is sent while Goblin is idle with no pi subagents
- **AND** the active session owns a running external-agent run
- **THEN** the external-agent run SHALL be cancelled
- **AND** the command SHALL report cancellation

#### Scenario: Other sessions are isolated

- **WHEN** `/cancel` is sent in session A
- **AND** session B owns running pi subagents or external-agent runs
- **THEN** session B's work SHALL remain active

#### Scenario: State-mutating commands do not use interrupt cascade

- **WHEN** `/new` is sent while delegated work is running
- **THEN** `/new` SHALL defer behind the active turn rather than invoking `interruptAndCascade`
- **AND** delegated work may continue until the turn finishes and old-session disposal begins

### Requirement: Cascade cancel is bounded by a timeout

`/cancel`'s cascade SHALL bound each individual main-agent abort, pi-subagent cancel, and external-run cancel by a per-call timeout (default 5 seconds). A target whose cancellation does not resolve within the timeout SHALL be reported in the cascade summary so the user-facing reply is honest about what may still be running. The helper MUST NOT issue `kill -9`; an external adapter may still perform its own specified graceful-then-forceful child-process teardown within its `cancel()` implementation.

#### Scenario: Stuck external run does not block command

- **WHEN** `/cancel` is sent and an external run's `cancel()` never resolves
- **THEN** the cascade SHALL stop waiting for that run after the timeout
- **AND** cancellation of other targets SHALL still be attempted
- **AND** the reply SHALL report one timed-out external run

#### Scenario: Stuck subagent does not block command

- **WHEN** `/cancel` is sent and a pi subagent's `cancel()` never resolves
- **THEN** the cascade SHALL stop waiting on that subagent after the timeout
- **AND** the command SHALL still complete within bounded time
- **AND** the reply SHALL report the timed-out subagent

#### Scenario: Stuck main agent does not prevent delegated-work cancellation

- **WHEN** `/cancel` is sent and the main runner's `abort()` never resolves
- **THEN** the cascade SHALL stop waiting on the main runner after the timeout
- **AND** pi-subagent and external-run cancellation SHALL still run
- **AND** the reply SHALL acknowledge the stuck main agent

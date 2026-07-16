# orchestration

## MODIFIED Requirements

### Requirement: External-agent runs follow Goblin session lifecycle

The composition root SHALL construct one shared `ExternalAgentRunner` and supply it to turn dispatch and interrupt wiring. `TurnDispatcher.disposeRunner(sessionId)` SHALL invoke and await `ExternalAgentRunner.cancelBySession(sessionId)` during session disposal, in addition to the pi-subagent cascade introduced by `cascade-cancel`. The method MUST NOT resolve until external-run cleanup has been attempted, even when no `AgentRunner` exists for the session.

Process shutdown SHALL stop the scheduler, invoke the external runner's process-shutdown operation, dispose the pi-subagent runner, dispose main agent runners, and stop Telegram polling before exit. The external process-shutdown operation SHALL cancel non-adoptable native runs but detach validated PTY-backed runs without changing them to a terminal state. External-agent shutdown failures SHALL be logged without skipping remaining shutdown steps. Explicit session disposal and cascade cancellation SHALL continue to cancel all owned external runs regardless of adapter kind.

#### Scenario: Session disposal cancels external runs

- **WHEN** `disposeRunner("session-a")` is called
- **AND** session A owns two non-terminal external-agent runs
- **THEN** `cancelBySession("session-a")` SHALL be awaited
- **AND** both external runs SHALL be terminal before `disposeRunner` resolves unless their adapter cleanup failed after terminal marking

#### Scenario: Disposal without main runner still cleans delegated work

- **WHEN** `disposeRunner("session-a")` is called with no cached `AgentRunner`
- **AND** session A owns a non-terminal external-agent run
- **THEN** that external run SHALL still be cancelled

#### Scenario: Session disposal is isolated

- **WHEN** session A is disposed
- **AND** session B owns a running external-agent run
- **THEN** session B's run SHALL remain active

#### Scenario: Graceful process shutdown preserves adoptable PTYs

- **WHEN** Goblin receives SIGINT or SIGTERM with one native and one validated PTY-backed run active
- **THEN** the external runner's process-shutdown operation SHALL be awaited before process exit
- **AND** the native run SHALL receive a cancellation attempt
- **AND** the PTY-backed run SHALL be detached and remain non-terminal for startup adoption
- **AND** remaining runner and bot shutdown steps SHALL still execute if one external cleanup fails

#### Scenario: Cascade cancel remains destructive

- **WHEN** `/cancel` cascades through a session that owns an adopted PTY-backed run
- **THEN** that run SHALL become `cancelled`
- **AND** its daemon session SHALL be killed and removed

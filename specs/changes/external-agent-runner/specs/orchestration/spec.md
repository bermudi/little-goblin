# orchestration

## ADDED Requirements

### Requirement: External-agent runs follow Goblin session lifecycle

The composition root SHALL construct one shared `ExternalAgentRunner` and supply it to turn dispatch and interrupt wiring. `TurnDispatcher.disposeRunner(sessionId)` SHALL invoke and await `ExternalAgentRunner.cancelBySession(sessionId)` during disposal, in addition to the pi-subagent cascade introduced by `cascade-cancel`. The method MUST NOT resolve until external-run cleanup has been attempted, even when no `AgentRunner` exists for the session.

Process shutdown SHALL stop the scheduler, dispose the external-agent runner, dispose the pi-subagent runner, dispose main agent runners, and stop Telegram polling before exit. External-agent cleanup failures SHALL be logged without skipping the remaining shutdown steps.

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

#### Scenario: Graceful process shutdown

- **WHEN** Goblin receives SIGINT or SIGTERM
- **THEN** the external-agent runner SHALL be disposed before process exit
- **AND** every non-terminal external run SHALL receive a cancellation attempt
- **AND** remaining runner and bot shutdown steps SHALL still execute if one external cleanup fails

### Requirement: Main AgentRunner receives session-bound external-agent tools

`TurnDispatcher.createRunner()` SHALL inject the shared `ExternalAgentRunner` and the session's resolved project directory into each main `AgentRunner`. During lazy tool assembly, `AgentRunner` SHALL register a session-bound `external_agent` tool only when external-agent configuration enables at least one backend. Pi subagents MUST NOT receive this tool.

External-run activity caused by the current tool call SHALL report coarse status through the current turn's `onStatusUpdate` callback. Background output after the `start` tool call returns SHALL be persisted for later `status` inspection and MUST NOT attempt to write directly to a stale Telegram buffer.

#### Scenario: Main agent gets tool

- **WHEN** a main runner initializes with at least one enabled external backend
- **THEN** its active tool names SHALL include `external_agent`
- **AND** the tool SHALL be bound to that runner's Goblin session id and resolved project directory

#### Scenario: Subagent tool set remains unchanged

- **WHEN** a pi subagent session is created
- **THEN** its custom tools MUST NOT include `external_agent`

#### Scenario: Start status uses current callback only

- **WHEN** `external_agent` starts a run during a main-agent turn
- **THEN** the current turn callback SHALL receive a coarse start status
- **AND** later background adapter output SHALL NOT retain or invoke that turn callback after the tool call returns

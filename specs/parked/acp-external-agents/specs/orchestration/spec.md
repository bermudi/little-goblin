# orchestration

## MODIFIED Requirements

### Requirement: External-agent runs follow Goblin session lifecycle

The composition root SHALL construct one shared `ExternalAgentRunner` and supply it to turn dispatch and interrupt wiring. `TurnDispatcher.disposeRunner(sessionId)` SHALL invoke and await `ExternalAgentRunner.cancelBySession(sessionId)` during session disposal, in addition to pi-subagent cascade cancellation. The method MUST NOT resolve until external-run cleanup has been attempted, even when no main `AgentRunner` exists for the session.

Startup SHALL initialize and reconcile the external runner after preflight and before Telegram polling or new external starts. Process shutdown SHALL stop the scheduler first, invoke the external runner's detach-aware `shutdown()` operation (replacing old cancel-all process disposal), dispose the pi-subagent runner, dispose main agent runners, and stop Telegram polling. External shutdown SHALL preserve valid resumable ACP runs only after terminating and confirming exit of their local server/terminal resources, then persisting `recoveryReadyAt` without `session/cancel` or `session/close`; non-resumable runs SHALL enter `stopping` with pending `interrupted` and become terminal only after destructive cleanup confirms exit. External-agent startup or shutdown failures SHALL be logged without ACP session ids, tasks, output, or environment values and without skipping remaining independent shutdown steps. A non-terminal ACP record lacking clean-detach proof SHALL fail external-runner initialization and therefore prevent polling/new starts rather than race possible hard-crash orphans.

Explicit session disposal and cascade cancellation SHALL remain destructive regardless of ACP resume capability. `/cancel`, `/new`, `/resume`, `/archive`, and `/project` SHALL call the owner-scoped cancellation path rather than process-shutdown detachment.

#### Scenario: Session disposal cancels external runs

- **WHEN** `disposeRunner("session-a")` is called
- **AND** session A owns two non-terminal ACP external-agent runs
- **THEN** `cancelBySession("session-a")` SHALL be awaited
- **AND** each run SHALL be terminal before `disposeRunner` resolves when cleanup confirms exit
- **AND** otherwise remain `stopping` with pending `cancelled` and block new external starts

#### Scenario: Disposal without main runner still cleans delegated work

- **WHEN** `disposeRunner("session-a")` is called with no cached main `AgentRunner`
- **AND** session A owns a non-terminal external run
- **THEN** that external run SHALL still be cancelled

#### Scenario: Session disposal is isolated

- **WHEN** session A is disposed
- **AND** session B owns a running external-agent run
- **THEN** session B's run SHALL remain active

#### Scenario: Startup reconciles before polling

- **WHEN** Goblin starts with persisted non-terminal external-agent records
- **THEN** the shared runner SHALL reconcile resumable and stale records before Telegram polling begins
- **AND** no new external run SHALL start before reconciliation completes

#### Scenario: Graceful process shutdown preserves resumable ACP work

- **WHEN** Goblin receives SIGINT or SIGTERM with one resumable and one non-resumable ACP run active
- **THEN** the external runner's `shutdown()` operation SHALL be awaited before process exit
- **AND** the resumable run SHALL remain non-terminal with its ACP resume checkpoint and `recoveryReadyAt` intact only after local child exit is confirmed
- **AND** the non-resumable run SHALL become `interrupted` only after local child exit confirms, otherwise remain `stopping`
- **AND** all local ACP server and terminal children SHALL receive cleanup attempts

#### Scenario: Cascade cancel remains destructive

- **WHEN** `/cancel` or session disposal targets a resumable ACP run
- **THEN** that run SHALL become `cancelled`
- **AND** its active prompt, ACP session, terminal children, and server process SHALL receive cleanup attempts
- **AND** startup MUST NOT resume the cancelled run

#### Scenario: Same-boot hard-crash record blocks startup

- **WHEN** external-runner initialization finds a non-terminal ACP record without clean-detach proof from the current host boot
- **THEN** Telegram polling and new external starts SHALL NOT begin
- **AND** Goblin SHALL log a bounded run-id diagnostic without task, output, ACP session id, or environment values

#### Scenario: Reboot resolves hard-crash uncertainty

- **WHEN** an unclean non-terminal record's persisted Linux boot id differs from the current boot id
- **THEN** startup SHALL mark it `interrupted` without resume
- **AND** polling MAY begin because no prior-boot process can remain alive

#### Scenario: External shutdown failure does not skip remaining cleanup

- **WHEN** external-runner shutdown fails
- **THEN** Goblin SHALL log the failure without task, output, ACP session id, or environment values
- **AND** SHALL still attempt pi-subagent disposal, main-runner disposal, and Telegram shutdown

### Requirement: Main AgentRunner receives session-bound external-agent tools

`TurnDispatcher.createRunner()` SHALL inject the shared `ExternalAgentRunner` and resolved project directory into each main `AgentRunner`. During lazy tool assembly, `AgentRunner` SHALL register the session-bound `external_agent` tool when the resolved enabled ACP server-id union (built-ins plus custom servers) is non-empty. Pi subagents MUST NOT receive it.

Current-tool-call activity SHALL report coarse status through the current turn callback. Background output after `start`/`message` returns SHALL persist for later status inspection and MUST NOT write to a stale Telegram buffer.

#### Scenario: Custom-only configuration gets the tool

- **WHEN** built-in `backends` is empty and one custom ACP server is configured
- **THEN** the main runner's active tools SHALL include `external_agent`
- **AND** its agent enum SHALL contain that custom server id

#### Scenario: No enabled server omits the tool

- **WHEN** neither built-ins nor custom servers are enabled
- **THEN** the main runner SHALL NOT register `external_agent`

#### Scenario: Pi subagent tool set remains unchanged

- **WHEN** a pi subagent session is created
- **THEN** its custom tools MUST NOT include `external_agent`

#### Scenario: Background output avoids stale callback

- **WHEN** an external run continues after its creating tool call returns
- **THEN** later output SHALL persist for status inspection
- **AND** MUST NOT invoke that completed turn's callback

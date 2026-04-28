# agent

## MODIFIED Requirements

### Requirement: Shared services point at $GOBLIN_HOME/pi-agent/

The `AgentRunner` SHALL obtain pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` from the `createPiServices()` function exported by `src/pi-host.ts`. `AuthStorage` and `ModelRegistry` SHALL be configured to read from and write to `$GOBLIN_HOME/pi-agent/` so authentication and model configuration persist across restarts and are shared by every session. `SettingsManager` SHALL be an in-memory instance with empty defaults.

#### Scenario: AuthStorage location

- **WHEN** an `AgentRunner` is created
- **THEN** pi's `AuthStorage` SHALL use `$GOBLIN_HOME/pi-agent/auth.json`

#### Scenario: Two sessions share the auth file path

- **WHEN** two `AgentRunner` instances are created in two different sessions
- **THEN** each runner's `AuthStorage` SHALL point at the same `$GOBLIN_HOME/pi-agent/auth.json` path

#### Scenario: Services obtained from pi-host

- **WHEN** `AgentRunner.init()` builds pi services
- **THEN** it SHALL call `createPiServices(home)` from `src/pi-host.ts`
- **AND** it SHALL NOT construct `AuthStorage`, `ModelRegistry`, or `SettingsManager` inline

### Requirement: cwd is the shared goblin workspace

Every `AgentRunner` SHALL pass `cwd = workdirPath($GOBLIN_HOME)` to `createAgentSession()`, where `workdirPath` is imported from `src/pi-host.ts`. Per-session workdirs MUST NOT be used.

#### Scenario: Runner created

- **WHEN** an `AgentRunner` is instantiated in any session
- **THEN** pi's `AgentSession` SHALL run with cwd `$GOBLIN_HOME/workdir/`

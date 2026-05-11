# Capability: AgentRunner Project Directory Support

## Requirements

### Requirement: AgentRunner uses projectDir for cwd and agentDir

When constructed with a `projectDir` option, AgentRunner SHALL use that directory as both `cwd` and `agentDir` when initializing the pi AgentSession. When `projectDir` is absent, it SHALL fall back to goblin's default paths.

#### Scenario: projectDir set

- **WHEN** AgentRunner is constructed with `projectDir: "/home/daniel/project"`
- **AND** `init()` is called
- **THEN** `cwd` is `/home/daniel/project`
- **AND** `agentDir` is `/home/daniel/project`
- **AND** the resource loader discovers skills from the project directory

#### Scenario: projectDir absent

- **WHEN** AgentRunner is constructed without `projectDir`
- **AND** `init()` is called
- **THEN** `cwd` is `$GOBLIN_HOME/workdir`
- **AND** `agentDir` is `$GOBLIN_HOME/goblin`

### Requirement: projectDir sourced from binding

The `projectDir` passed to `AgentRunner` SHALL originate from the chat surface binding (`topic-settings.json`), not from `SessionState`. New sessions SHALL NOT include `projectDir` in `state.json`.

#### Scenario: projectDir from binding used by AgentRunner

- **WHEN** `AgentRunner` is constructed with `projectDir: "/home/daniel/project"` in `AgentRunnerOptions`
- **AND** `init()` is called
- **THEN** `cwd` SHALL be `/home/daniel/project`
- **AND** `agentDir` SHALL be `/home/daniel/project`

#### Scenario: no projectDir uses defaults

- **WHEN** `AgentRunner` is constructed without `projectDir` in `AgentRunnerOptions`
- **AND** `init()` is called
- **THEN** `cwd` SHALL be `$GOBLIN_HOME/workdir`
- **AND** `agentDir` SHALL be `$GOBLIN_HOME/goblin`

### Requirement: SessionState projectDir is deprecated

`SessionState` MAY retain an optional `projectDir` field for backward compatibility during migration, but goblin code SHALL NOT read or write it. The field is treated as absent.

#### Scenario: SessionState with legacy projectDir

- **WHEN** a `SessionState` loaded from disk contains `projectDir: "/home/daniel/old"`
- **AND** `AgentRunner` is constructed without an explicit `projectDir` option
- **THEN** `AgentRunner` SHALL use the default paths, ignoring the legacy field

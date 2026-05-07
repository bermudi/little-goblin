# Capability: AgentRunner Project Directory Support

## ADDED Requirement: AgentRunner uses projectDir for cwd and agentDir

When constructed with a `projectDir` option, AgentRunner SHALL use that directory as both `cwd` and `agentDir` when initializing the pi AgentSession. When `projectDir` is absent, it SHALL fall back to goblin's default paths.

### Scenario: projectDir set
- **WHEN** AgentRunner is constructed with `projectDir: "/home/daniel/project"`
- **AND** `init()` is called
- **THEN** `cwd` is `/home/daniel/project`
- **AND** `agentDir` is `/home/daniel/project`
- **AND** the resource loader discovers skills from the project directory

### Scenario: projectDir absent
- **WHEN** AgentRunner is constructed without `projectDir`
- **AND** `init()` is called
- **THEN** `cwd` is `$GOBLIN_HOME/workdir`
- **AND** `agentDir` is `$GOBLIN_HOME/goblin`

## ADDED Requirement: session-scoped projectDir

The `SessionState` type SHALL include an optional `projectDir` field. The `SessionManager` SHALL provide a `setProjectDir` method to update this field atomically.

### Scenario: setProjectDir updates state
- **WHEN** `manager.setProjectDir(sessionId, "/foo")` is called
- **THEN** `state.json` is rewritten with the new `projectDir`
- **AND** subsequent `resolve()` calls return the updated state

### Scenario: setProjectDir clears binding
- **WHEN** `manager.setProjectDir(sessionId, undefined)` is called
- **THEN** `state.json` is rewritten without `projectDir`
- **AND** subsequent `resolve()` calls return state with no `projectDir`

### Scenario: setProjectDir with unknown session
- **WHEN** `manager.setProjectDir("nonexistent", "/foo")` is called
- **THEN** it throws "session not found: nonexistent"

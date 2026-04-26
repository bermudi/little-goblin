# agent

## ADDED Requirements

### Requirement: AgentRunner injects memory snapshot as per-turn aside

The `AgentRunner` SHALL load the current contents of `$GOBLIN_HOME/memory/memory.md` and `$GOBLIN_HOME/memory/user.md` from disk before each `prompt()` call and inject them into the next turn via `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })`. The snapshot MUST be loaded fresh for every turn so that writes performed in earlier turns become visible on subsequent turns. The snapshot MUST NOT be added to pi's `_baseSystemPrompt`; whatever value `_baseSystemPrompt` holds at AgentSession creation MUST remain unchanged across turns by this change.

#### Scenario: First turn

- **WHEN** `prompt()` is called for the first time on an `AgentRunner`
- **THEN** the runner SHALL read both memory files from disk
- **AND** dispatch the formatted snapshot via `sendCustomMessage(..., { deliverAs: "nextTurn" })` before invoking the underlying prompt

#### Scenario: Subsequent turn after a memory write

- **WHEN** the agent calls `memory.add` during turn N
- **AND** the user sends a new message that triggers turn N+1
- **THEN** the snapshot loaded for turn N+1 SHALL include the entry written during turn N

#### Scenario: System prompt unchanged across turns

- **WHEN** memory files change on disk between turns
- **THEN** `agent.state.systemPrompt` between turns SHALL remain equal to the value `_baseSystemPrompt` held at AgentSession creation

#### Scenario: Empty memory store

- **WHEN** both memory files are absent or empty
- **THEN** the runner MAY skip the `sendCustomMessage` call
- **AND** the prompt SHALL proceed without an aside

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include a tool definition named `memory` in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller.

#### Scenario: Runner constructed

- **WHEN** `AgentRunner` is constructed for a Telegram session
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include a tool definition named `memory`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, and the `memory` tool

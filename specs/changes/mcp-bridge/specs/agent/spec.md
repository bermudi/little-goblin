# agent

## ADDED Requirements

### Requirement: AgentRunner conditionally registers MCP tools

The `AgentRunner` constructor SHALL accept an optional `mcpRunner?: McpRunner`. When `mcpRunner` is present and `cfg.mcp` is defined, `buildCustomTools()` SHALL append the tools returned by `createMcpTools(this.mcpRunner)` to the array passed to `createAgentSession`. When `mcpRunner` is absent or `cfg.mcp` is undefined, no MCP tools SHALL be added.

The presence or absence of enabled/reachable MCP servers SHALL NOT affect whether `mcp_call` and `mcp_describe` are registered; an empty catalog or unreachable `mcporter` simply produces an empty or error-bearing tool surface. Caller-supplied `customTools` pass-through is governed by the existing `AgentRunner accepts session-bound custom tools` requirement in the agent canon and is not modified by this change.

#### Scenario: MCP runner present and config defined

- **WHEN** `AgentRunner` is constructed with `mcpRunner: runner` and `cfg.mcp` is defined
- **THEN** `buildCustomTools()` SHALL include the `mcp_call` and `mcp_describe` tools after the caller-supplied custom tools and memory tools

#### Scenario: MCP runner present with empty enabled list

- **WHEN** `AgentRunner` is constructed with `mcpRunner: runner` and `cfg.mcp` is `{ enabled: [] }`
- **THEN** `buildCustomTools()` SHALL still include `mcp_call` and `mcp_describe`
- **AND** the `mcp_call` description SHALL contain an empty catalog

#### Scenario: MCP runner absent

- **WHEN** `AgentRunner` is constructed without `mcpRunner`
- **THEN** `buildCustomTools()` SHALL NOT include `mcp_call` or `mcp_describe`

#### Scenario: MCP runner present but config absent

- **WHEN** `AgentRunner` is constructed with `mcpRunner: runner` but `cfg.mcp` is `undefined`
- **THEN** `buildCustomTools()` SHALL NOT include `mcp_call` or `mcp_describe`

# config

## ADDED Requirements

### Requirement: MCP configuration block

The config file SHALL accept an optional `mcp` block controlling Goblin's MCP tool bridge. The block SHALL have the following fields, all optional:

- `enabled` — array of server names to expose. When omitted, all servers `mcporter list` reports are exposed.
- `configPath` — path to the `mcporter.json` config file. A leading `~` SHALL be expanded to `os.homedir()`. Relative paths SHALL be resolved against `goblinHome`. When omitted, Goblin passes no `--config` flag and `mcporter` uses its own default discovery.
- `defaultTimeoutMs` — per-call timeout in milliseconds, used for both the inner `mcporter --timeout` and the outer spawn timeout (`defaultTimeoutMs + 5000`). Defaults to `120000` (2 minutes). Minimum `5000`, maximum `1800000` (30 minutes).
- `maxResultChars` — maximum length of the text returned by `mcp_call` and `mcp_describe`. Defaults to `16000`. Minimum `1000`, maximum `100000`.

The loaded `Config` object SHALL expose `mcp?: McpConfig` with the resolved values. The `mcp` block SHALL be frozen at load time like the `externalAgents` block.

When the `mcp` block is absent from `goblin.json5`, `Config.mcp` SHALL be `undefined` and the MCP tools SHALL NOT be registered. When the `mcp` block is present, the MCP tools SHALL be registered; an empty `enabled` list or unreachable `mcporter` SHALL result in an empty catalog and error-bearing calls, not the suppression of the tools.

#### Scenario: Default values when block present but fields omitted

- **WHEN** `goblin.json5` contains `mcp: {}`
- **THEN** `Config.mcp` SHALL be defined with `enabled: undefined`, `configPath: undefined`, `defaultTimeoutMs: 120000`, `maxResultChars: 16000`

#### Scenario: Enabled list filters servers

- **WHEN** `goblin.json5` contains `mcp: { enabled: ["tavily", "deepwiki"] }`
- **THEN** `Config.mcp.enabled` SHALL be `["tavily", "deepwiki"]`

#### Scenario: ConfigPath with tilde expansion

- **WHEN** `goblin.json5` contains `mcp: { configPath: "~/.mcporter/mcporter.json" }`
- **AND** `os.homedir()` returns `/home/alice`
- **THEN** `Config.mcp.configPath` SHALL be `/home/alice/.mcporter/mcporter.json`

#### Scenario: ConfigPath relative to goblinHome

- **WHEN** `goblin.json5` contains `mcp: { configPath: "mcporter.json" }`
- **AND** `goblinHome` is `/home/alice/.goblin`
- **THEN** `Config.mcp.configPath` SHALL be `/home/alice/.goblin/mcporter.json`

#### Scenario: Timeout below minimum rejected

- **WHEN** `goblin.json5` contains `mcp: { defaultTimeoutMs: 1000 }`
- **THEN** Zod validation SHALL reject with a minimum error

#### Scenario: Timeout above maximum rejected

- **WHEN** `goblin.json5` contains `mcp: { defaultTimeoutMs: 3600000 }`
- **THEN** Zod validation SHALL reject with a maximum error

#### Scenario: Block absent

- **WHEN** `goblin.json5` does not contain an `mcp` field
- **THEN** `Config.mcp` SHALL be `undefined`
- **AND** the MCP tools SHALL NOT be registered with the agent

#### Scenario: Empty enabled array

- **WHEN** `goblin.json5` contains `mcp: { enabled: [] }`
- **THEN** `Config.mcp.enabled` SHALL be `[]`
- **AND** the `McpRunner` catalog SHALL be empty
- **AND** the `mcp_call` and `mcp_describe` tools SHALL still be registered with an empty catalog in the description

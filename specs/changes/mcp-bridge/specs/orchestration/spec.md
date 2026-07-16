# orchestration

## ADDED Requirements

### Requirement: MCP runner is threaded through to AgentRunner

The `TurnDispatcher` SHALL accept an optional `mcpRunner?: McpRunner` via `TurnDispatcherOptions` and forward it to the `AgentRunner` constructor in `createRunner()`. The `TelegramIntake` SHALL accept an optional `mcpRunner?: McpRunner` via `TelegramIntakeOptions` and pass it to the `TurnDispatcher` constructor. The dispatcher SHALL NOT inspect or use the `McpRunner` directly; it is pure pass-through.

The composition root (`src/bot.ts`) SHALL construct the `McpRunner` from `cfg.mcp` and `cfg.goblinHome` and inject it into `createTelegramIntake`. When `cfg.mcp` is absent, no `McpRunner` is constructed and none is passed through.

#### Scenario: MCP runner threaded through to AgentRunner

- **WHEN** `TurnDispatcherOptions` includes `mcpRunner: runner`
- **AND** `createRunner()` constructs a new `AgentRunner`
- **THEN** the `AgentRunnerOptions` SHALL include `mcpRunner: runner`
- **AND** the resulting runner SHALL expose the `mcp_call` and `mcp_describe` tools when `cfg.mcp` is defined

#### Scenario: MCP runner absent from dispatcher options

- **WHEN** `TurnDispatcherOptions` does not include `mcpRunner`
- **THEN** `createRunner()` SHALL construct the `AgentRunner` without `mcpRunner`
- **AND** the resulting runner SHALL NOT expose MCP tools

#### Scenario: Telegram intake passes mcpRunner to dispatcher

- **WHEN** `TelegramIntake` is constructed with `mcpRunner: runner`
- **THEN** the `TurnDispatcher` it creates SHALL be constructed with `mcpRunner: runner`

#### Scenario: buildBot constructs mcpRunner from config

- **WHEN** `cfg.mcp` is defined
- **THEN** `buildBot` SHALL construct an `McpRunner` from `cfg.mcp` and `cfg.goblinHome`
- **AND** it SHALL pass that runner to `createTelegramIntake`
- **AND** the bot SHALL start normally

#### Scenario: buildBot omits mcpRunner when config absent

- **WHEN** `cfg.mcp` is `undefined`
- **THEN** `buildBot` SHALL NOT construct an `McpRunner`
- **AND** it SHALL pass `undefined` as the `mcpRunner` option to `createTelegramIntake`

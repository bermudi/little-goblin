# pi-host

## REMOVED Requirements

### Requirement: Pi-host module provides shared pi service construction

### Requirement: Pi-host module exports pi filesystem path helpers

### Requirement: Pi-host module has no dependency on agent or subagent modules

## ADDED Requirements

### Requirement: paths module exports goblin filesystem path helpers

The `src/paths.ts` module SHALL export path helper functions `workdirPath(home)`, `agentsMdPath(home)`, and `soulMdPath(home)` returning paths under `$GOBLIN_HOME`. The module MUST NOT depend on any AI/LLM library — only `node:path`.

#### Scenario: workdirPath

- **WHEN** `workdirPath("/home/user/goblin")` is called
- **THEN** it SHALL return `"/home/user/goblin/workdir"`

#### Scenario: agentsMdPath

- **WHEN** `agentsMdPath("/home/user/goblin")` is called
- **THEN** it SHALL return `"/home/user/goblin/AGENTS.md"`

#### Scenario: No dependency on agent or subagent modules

- **WHEN** the TypeScript project is compiled
- **THEN** `src/paths.ts` SHALL NOT have any import path starting with `../agent/` or `../subagents/`

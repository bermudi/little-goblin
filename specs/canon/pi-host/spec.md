# pi-host

## Requirements

### Requirement: Pi-host module provides shared pi service construction

The `src/pi-host.ts` module SHALL export a `PiServices` type and a `createPiServices(home: string): PiServices` function that returns `{ authStorage: AuthStorage, modelRegistry: ModelRegistry, settingsManager: SettingsManager }` configured to use `$GOBLIN_HOME/goblin/` as the pi configuration directory.

#### Scenario: Services created with correct paths

- **WHEN** `createPiServices("/home/user/goblin")` is called
- **THEN** the returned `authStorage` SHALL point at `/home/user/goblin/goblin/auth.json`
- **AND** the returned `modelRegistry` SHALL point at `/home/user/goblin/goblin/models.json`
- **AND** the returned `settingsManager` SHALL be an in-memory instance with empty defaults

#### Scenario: Idempotent — same home, same result

- **WHEN** `createPiServices(home)` is called twice with the same `home`
- **THEN** each call SHALL return new, independent service instances (no internal caching)

### Requirement: Pi-host module exports pi filesystem path helpers

The `src/pi-host.ts` module SHALL export path helper functions `workdirPath(home)`, `piAgentDir(home)`, and `agentsMdPath(home)` as the canonical source for pi-related filesystem paths.

#### Scenario: Path helpers available

- **WHEN** a consumer imports `{ workdirPath, piAgentDir, agentsMdPath }` from `pi-host.ts`
- **THEN** each SHALL return the same paths previously defined in `src/agent/paths.ts`

### Requirement: Pi-host module has no dependency on agent or subagent modules

The `src/pi-host.ts` module MUST NOT import from `src/agent/` or `src/subagents/`. It SHALL depend only on `@mariozechner/pi-coding-agent` types and `node:path`.

#### Scenario: Import check

- **WHEN** the TypeScript project is compiled
- **THEN** `src/pi-host.ts` SHALL NOT have any import path starting with `../agent/` or `../subagents/`

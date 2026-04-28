# subagents

## MODIFIED Requirements

### Requirement: SubagentRunner manages subagent lifecycle

The `SubagentRunner` class SHALL handle spawning, revival, and status tracking for all subagents. It SHALL obtain pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` from the `createPiServices()` function exported by `src/pi-host.ts`.

#### Scenario: Runner creation

- **WHEN** `SubagentRunner` is instantiated
- **THEN** it SHALL have access to shared services (AuthStorage, ModelRegistry, SettingsManager) obtained from `createPiServices()`
- **AND** it SHALL track active subagents in memory

#### Scenario: Services from pi-host

- **WHEN** `SubagentRunner.getSharedServices()` is called
- **THEN** it SHALL call `createPiServices(this.cfg.goblinHome)` from `src/pi-host.ts`
- **AND** it SHALL NOT construct `AuthStorage`, `ModelRegistry`, or `SettingsManager` inline

#### Scenario: Lazy caching preserved

- **WHEN** `getSharedServices()` is called twice within the same `SubagentRunner` lifetime
- **THEN** `createPiServices()` SHALL be called only once
- **AND** the cached result SHALL be returned on subsequent calls



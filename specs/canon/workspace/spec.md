# workspace

## Requirements

### Requirement: Workspace path module centralizes goblin-owned paths

The `src/workspace/paths.ts` module SHALL export canonical path helpers for the persistent personal workspace, attachments, prompt files, and the current legacy skill directory under `$GOBLIN_HOME/workspace/`. `workdirPath` MAY remain as an offline-migration compatibility helper for the retired `$GOBLIN_HOME/scratch/workdir/` location; runtime code MUST NOT treat it as execution authority.

#### Scenario: Workspace path helpers available

- **WHEN** a consumer imports `{ workspacePath, attachmentsPath, agentsMdPath, soulMdPath, heartbeatMdPath, skillsPath }` from `src/workspace/paths.ts`
- **THEN** `workspacePath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/`
- **AND** `attachmentsPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/attachments/`
- **AND** `agentsMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/AGENTS.md`
- **AND** `soulMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/SOUL.md`
- **AND** `heartbeatMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/HEARTBEAT.md`
- **AND** `skillsPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/skills/`

#### Scenario: Retired workdir helper is migration-only

- **WHEN** application runtime code resolves a personal Execution Environment
- **THEN** it SHALL use `workspacePath(home)`
- **AND** it SHALL NOT use `workdirPath(home)`

### Requirement: Workspace path module has no runtime dependencies

The `src/workspace/paths.ts` module SHALL depend only on `node:path` for path construction. It SHALL NOT perform filesystem I/O or import application modules.

#### Scenario: Import check

- **WHEN** the TypeScript project is compiled
- **THEN** `src/workspace/paths.ts` SHALL NOT import from any module other than `node:path`

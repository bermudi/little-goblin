# workspace

## Requirements

### Requirement: Workspace path module centralizes goblin-owned paths

The `src/workspace/paths.ts` module SHALL export canonical path helpers for goblin-owned directories and user-authored prompt files under `$GOBLIN_HOME/workspace/` and the ephemeral scratch workdir.

#### Scenario: Workspace path helpers available

- **WHEN** a consumer imports `{ workdirPath, agentsMdPath, soulMdPath, heartbeatMdPath, skillsPath }` from `src/workspace/paths.ts`
- **THEN** `workdirPath(home)` SHALL resolve to `$GOBLIN_HOME/scratch/workdir/`
- **AND** `agentsMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/AGENTS.md`
- **AND** `soulMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/SOUL.md`
- **AND** `heartbeatMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/HEARTBEAT.md`
- **AND** `skillsPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/skills/`

### Requirement: Workspace path module has no runtime dependencies

The `src/workspace/paths.ts` module SHALL depend only on `node:path` for path construction. It SHALL NOT perform filesystem I/O or import application modules.

#### Scenario: Import check

- **WHEN** the TypeScript project is compiled
- **THEN** `src/workspace/paths.ts` SHALL NOT import from any module other than `node:path`

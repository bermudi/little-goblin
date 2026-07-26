# workspace

## MODIFIED Requirements

### Requirement: Workspace path module centralizes goblin-owned paths

`src/workspace/paths.ts` SHALL export pure canonical helpers for the persistent personal workspace, its prompt/attachment paths, and two distinct pi-native skill catalogs. `goblinSkillsPath(home)` SHALL resolve to `$GOBLIN_HOME/.agents/skills/`; `personalEnvironmentSkillsPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/.agents/skills/`. The legacy `skillsPath(home)` MAY remain temporarily as a deprecated alias of `goblinSkillsPath(home)` while runtime callers migrate, but new code MUST use the scope-specific names.

#### Scenario: Skill catalog helpers are distinct

- **WHEN** a caller resolves both skill paths
- **THEN** the Goblin catalog SHALL be `$GOBLIN_HOME/.agents/skills/`
- **AND** the personal environment catalog SHALL be `$GOBLIN_HOME/workspace/.agents/skills/`
- **AND** neither SHALL resolve to legacy `$GOBLIN_HOME/workspace/skills/`

#### Scenario: Existing prompt paths are preserved

- **WHEN** prompt and attachment helpers are resolved
- **THEN** `SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md` SHALL remain under `$GOBLIN_HOME/workspace/`
- **AND** the personal execution root SHALL remain `$GOBLIN_HOME/workspace`

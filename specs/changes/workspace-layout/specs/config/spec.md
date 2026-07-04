# config

## MODIFIED Requirements

### Requirement: Ensure GOBLIN_HOME directory structure

The system SHALL create required subdirectories under `GOBLIN_HOME` at startup, organized into three top-level groups: `workspace/` (user-authored prompt files and skills), `state/` (machine-managed state), and `scratch/` (ephemeral subagent workspace).

Directory creation SHALL occur in two phases around migration:

1. **Pre-migration:** create only the three top-level group directories (`workspace/`, `state/`, `scratch/`). Migration-target subdirectories (`workspace/skills/`, `workspace/agents/`, `state/sessions/`, `state/memory/`, `state/pi/`, `scratch/workdir/`, `scratch/subagents/`) SHALL NOT be created in this phase — they are created by migration (if legacy paths exist) or in the post-migration phase.
2. **Post-migration:** after migration completes, create any migration-target subdirectories that still do not exist (fresh install or legacy install where the corresponding legacy path was absent).

The following directories SHALL exist after startup completes:

- `workspace/` — prompt files and skills
- `workspace/skills/` — goblin's pi skills
- `workspace/agents/` — named agent definitions
- `state/` — machine-managed state
- `state/sessions/` — session directories
- `state/memory/` — agent-curated memory tree
- `state/pi/` — pi auth and model registry
- `scratch/` — ephemeral workspace
- `scratch/workdir/` — shared subagent cwd
- `scratch/subagents/` — subagent instance directories

#### Scenario: First run with empty GOBLIN_HOME

- **WHEN** `ensureGoblinHome()` is called with a fresh directory
- **THEN** it SHALL create `workspace/`, `workspace/skills/`, `workspace/agents/`, `state/`, `state/sessions/`, `state/memory/`, `state/pi/`, `scratch/`, `scratch/workdir/`, and `scratch/subagents/` directories
- **AND** no `renameSync` SHALL occur (no legacy paths to migrate)

#### Scenario: Directories already exist

- **WHEN** `ensureGoblinHome()` is called and directories already exist
- **THEN** it SHALL complete without error (idempotent)

## ADDED Requirements

### Requirement: One-time migration of legacy root-level paths

On startup, the system SHALL migrate legacy root-level paths to their new locations. Migration SHALL run after the three top-level group directories (`workspace/`, `state/`, `scratch/`) are created and before migration-target subdirectories are created. For each legacy path that exists at `$GOBLIN_HOME` root and whose corresponding new path does not exist, the system SHALL `renameSync` the legacy path to the new path.

The migration mapping SHALL be:

- `$GOBLIN_HOME/SOUL.md` → `$GOBLIN_HOME/workspace/SOUL.md`
- `$GOBLIN_HOME/AGENTS.md` → `$GOBLIN_HOME/workspace/AGENTS.md`
- `$GOBLIN_HOME/skills/` → `$GOBLIN_HOME/workspace/skills/`
- `$GOBLIN_HOME/agents/` → `$GOBLIN_HOME/workspace/agents/`
- `$GOBLIN_HOME/config.json` → `$GOBLIN_HOME/state/bindings.json`
- `$GOBLIN_HOME/topic-settings.json` → `$GOBLIN_HOME/state/topic-settings.json`
- `$GOBLIN_HOME/schedules.json` → `$GOBLIN_HOME/state/schedules.json`
- `$GOBLIN_HOME/sessions/` → `$GOBLIN_HOME/state/sessions/`
- `$GOBLIN_HOME/memory/` → `$GOBLIN_HOME/state/memory/`
- `$GOBLIN_HOME/goblin/` → `$GOBLIN_HOME/state/pi/`
- `$GOBLIN_HOME/workdir/` → `$GOBLIN_HOME/scratch/workdir/`
- `$GOBLIN_HOME/subagents/` → `$GOBLIN_HOME/scratch/subagents/`

Migration SHALL run before any other startup step that reads from or writes to these paths. If a legacy path does not exist (already migrated or fresh install), the system SHALL skip it without error. If both legacy and new paths exist, the system SHALL skip migration for that item and log a warning (the operator resolves the conflict manually).

#### Scenario: Fresh install with no legacy paths

- **WHEN** `ensureGoblinHome()` runs on a fresh `$GOBLIN_HOME` with no legacy paths
- **THEN** no `renameSync` SHALL occur
- **AND** the new directory tree SHALL be created empty

#### Scenario: Legacy install migrates all paths

- **WHEN** startup runs on a `$GOBLIN_HOME` with legacy root-level paths (`SOUL.md`, `config.json`, `sessions/`, etc.) and no new paths
- **THEN** each legacy path SHALL be renamed to its new location
- **AND** the legacy paths SHALL no longer exist at `$GOBLIN_HOME` root
- **AND** migration-target directories (e.g. `state/sessions/`, `state/memory/`) SHALL contain the migrated content, not be empty

#### Scenario: Legacy install migrates directory contents despite top-level groups existing

- **WHEN** startup runs on a `$GOBLIN_HOME` with legacy root-level directories (`sessions/`, `memory/`, `goblin/`, `workdir/`, `subagents/`, `skills/`, `agents/`)
- **AND** the top-level group directories (`workspace/`, `state/`, `scratch/`) have been created in the pre-migration phase but their subdirectories have NOT been created
- **THEN** each legacy directory SHALL be `renameSync`'d into its new location under the appropriate group
- **AND** the new directories SHALL contain the legacy content
- **AND** the legacy directories SHALL no longer exist at `$GOBLIN_HOME` root

#### Scenario: Already-migrated install skips migration

- **WHEN** startup runs on a `$GOBLIN_HOME` where new paths exist and legacy paths do not
- **THEN** no `renameSync` SHALL occur
- **AND** startup SHALL proceed normally

#### Scenario: Conflict when both legacy and new exist

- **WHEN** both `$GOBLIN_HOME/config.json` (legacy) and `$GOBLIN_HOME/state/bindings.json` (new) exist
- **THEN** the system SHALL NOT rename either file
- **AND** the system SHALL log a warning naming both paths
- **AND** startup SHALL continue using the new path

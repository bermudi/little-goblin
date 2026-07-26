# config

## ADDED Requirements

### Requirement: Legacy Goblin skills migrate without merging

Startup SHALL migrate legacy `$GOBLIN_HOME/workspace/skills/` to `$GOBLIN_HOME/.agents/skills/` before skill consumers initialize. A legacy-only directory SHALL be atomically renamed. If the destination exists and is empty, startup MAY remove the empty destination before the rename. If both paths contain entries, startup MUST fail with both paths and SHALL NOT merge, overwrite, or delete either catalog. A destination-only or neither-path state SHALL be treated as already migrated. Migration SHALL be idempotent after restart.

#### Scenario: Legacy catalog migrates

- **GIVEN** legacy `workspace/skills/` contains skills
- **AND** `.agents/skills/` does not exist or is empty
- **WHEN** startup migration runs
- **THEN** the legacy tree SHALL become `$GOBLIN_HOME/.agents/skills/`
- **AND** every skill file SHALL be preserved

#### Scenario: Populated destination conflicts

- **GIVEN** both legacy and destination catalogs contain entries
- **WHEN** startup migration runs
- **THEN** startup SHALL fail before polling
- **AND** the error SHALL identify both paths
- **AND** neither tree SHALL be changed

#### Scenario: Migration rerun

- **GIVEN** only `$GOBLIN_HOME/.agents/skills/` exists
- **WHEN** migration reruns
- **THEN** it SHALL leave the catalog unchanged

## MODIFIED Requirements

### Requirement: Ensure GOBLIN_HOME directory structure

Startup SHALL ensure the persistent personal workspace, machine-managed state, and both user-authored skill catalog roots exist through canonical path helpers. It SHALL create `$GOBLIN_HOME/.agents/skills/` for Goblin-wide skills and `$GOBLIN_HOME/workspace/.agents/skills/` for personal-environment skills. It MUST run legacy skill migration before eagerly creating a non-empty migration destination. Existing unrelated state/scratch compatibility directories remain governed by their current requirements until the separate storage-layout cleanup lands.

#### Scenario: Fresh home

- **WHEN** startup initializes a fresh GOBLIN_HOME
- **THEN** it SHALL create `$GOBLIN_HOME/.agents/skills/`
- **AND** SHALL create `$GOBLIN_HOME/workspace/.agents/skills/`
- **AND** SHALL create the existing prompt and state directories

#### Scenario: Existing home

- **WHEN** both canonical catalog roots already exist
- **THEN** directory initialization SHALL be idempotent

# config

## ADDED Requirements

### Requirement: skillSources config field

The config file SHALL accept an optional `skillSources` field controlling where goblin's main agent discovers pi skills. The field SHALL accept one of three string values:

- `"goblin-only"` (default) — only `$GOBLIN_HOME/skills/` is available.
- `"user"` — goblin skills plus the user's personal skills from `~/.agents/skills/` and cwd ancestor `.agents/skills/` directories.
- `"auto"` — pi's full default auto-discovery (cwd ancestor walk, user home dirs, packages).

When `skillSources` is absent from the config file, it SHALL default to `"goblin-only"`.

#### Scenario: Default when field absent

- **WHEN** `goblin.json5` has no `skillSources` field
- **THEN** the Config SHALL contain `skillSources: "goblin-only"`

#### Scenario: Explicit goblin-only

- **WHEN** `goblin.json5` contains `skillSources: "goblin-only"`
- **THEN** the Config SHALL contain `skillSources: "goblin-only"`

#### Scenario: User mode

- **WHEN** `goblin.json5` contains `skillSources: "user"`
- **THEN** the Config SHALL contain `skillSources: "user"`

#### Scenario: Auto mode

- **WHEN** `goblin.json5` contains `skillSources: "auto"`
- **THEN** the Config SHALL contain `skillSources: "auto"`

#### Scenario: Invalid value

- **WHEN** `goblin.json5` contains `skillSources: "everything"`
- **THEN** Zod validation SHALL reject with an enum error

## MODIFIED Requirements

### Requirement: Expose typed Config interface

The system SHALL expose a `Config` interface with all configuration fields typed explicitly, derived from the Zod schema.

#### Scenario: Config consumer accesses fields

- **WHEN** a module imports `Config` type
- **THEN** it SHALL have access to: `botToken`, `allowedTgUserIds`, `modelName`, `poeApiKey?`, `openrouterApiKey?`, `openaiApiKey?`, `anthropicApiKey?`, `goblinHome`, `logLevel`, `skillSources`

### Requirement: Validate config with Zod schema

The system SHALL validate the fully-resolved config object against a Zod schema. Validation failures SHALL cause a startup error with Zod's formatted error output.

#### Scenario: Invalid model name type

- **WHEN** `model` is set to a number instead of a string
- **THEN** Zod validation SHALL reject with a type error

#### Scenario: Invalid log level

- **WHEN** `logLevel` is set to `"verbose"` (not in the enum)
- **THEN** Zod validation SHALL reject with an enum error

#### Scenario: Valid config passes

- **WHEN** all required fields are present and correctly typed after resolution
- **THEN** `loadConfig()` SHALL return a valid `Config` object

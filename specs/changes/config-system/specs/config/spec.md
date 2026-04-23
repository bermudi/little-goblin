# config

## MODIFIED Requirements

### Requirement: Load required environment variables

The system SHALL load configuration from a JSON5 config file at `$GOBLIN_HOME/goblin.json5`, resolving string values using the pi-style resolution pattern. Required fields missing or unresolvable after resolution SHALL cause a startup error with a clear message.

#### Scenario: Config file not found

- **WHEN** `goblin.json5` does not exist at the resolved `GOBLIN_HOME` path
- **THEN** `loadConfig()` SHALL throw an error indicating the expected path

#### Scenario: Required field missing from config file

- **WHEN** `botToken` is absent from `goblin.json5`
- **THEN** `loadConfig()` SHALL throw an error naming the missing field

#### Scenario: Required field resolves to empty

- **WHEN** `botToken` is set to an env var name that is unset and doesn't look like a literal key
- **THEN** `loadConfig()` SHALL throw an error indicating the value could not be resolved

### Requirement: Parse ALLOWED_TG_USER_IDS as comma-separated set

The system SHALL accept `allowedUsers` as an array of integers in the config file, validated by the Zod schema. The field MUST contain at least one entry.

#### Scenario: Array of user IDs

- **WHEN** `allowedUsers` is `[123, 456, 789]` in `goblin.json5`
- **THEN** the resulting `allowedTgUserIds` SHALL be a Set containing [123, 456, 789]

#### Scenario: Empty array

- **WHEN** `allowedUsers` is `[]`
- **THEN** Zod validation SHALL reject the config with a clear error

### Requirement: Load optional environment variables with defaults

The system SHALL apply defaults for optional fields not present in the config file. Defaults SHALL be defined in the Zod schema.

#### Scenario: goblinHome defaults to ~/goblin

- **WHEN** `goblinHome` is not present in `goblin.json5`
- **THEN** `goblinHome` SHALL default to `$HOME/goblin`

#### Scenario: logLevel defaults to info

- **WHEN** `logLevel` is not present in `goblin.json5`
- **THEN** `logLevel` SHALL default to `"info"`

#### Scenario: Optional API keys absent

- **WHEN** API key fields (e.g. `poeApiKey`) are not present in `goblin.json5`
- **THEN** the corresponding config fields SHALL be `undefined`

### Requirement: Expose typed Config interface

The system SHALL expose a `Config` interface with all configuration fields typed explicitly, derived from the Zod schema.

#### Scenario: Config consumer accesses fields

- **WHEN** a module imports `Config` type
- **THEN** it SHALL have access to: `botToken`, `allowedTgUserIds`, `modelName`, `poeApiKey?`, `openrouterApiKey?`, `openaiApiKey?`, `anthropicApiKey?`, `goblinHome`, `logLevel`

## ADDED Requirements

### Requirement: Resolve config values using pi-style resolution

The system SHALL resolve string config values using a three-way pattern, applied at startup:

1. If the string starts with `!`, execute the remainder as a shell command, cache the trimmed stdout.
2. Else if the string matches an existing `process.env` key, use the env var value.
3. Otherwise, treat the string as a literal value.

Resolution SHALL occur once during `loadConfig()`. Shell commands SHALL have a 10-second timeout.

#### Scenario: Shell command resolution

- **WHEN** a config value is `"!pass-cli item view 'pass://Keys/Poe/Api Key'"`
- **THEN** the system SHALL execute the command, use trimmed stdout as the resolved value, and cache it

#### Scenario: Env var resolution

- **WHEN** a config value is `"POE_API_KEY"` and `process.env.POE_API_KEY` is `"sk-abc123"`
- **THEN** the resolved value SHALL be `"sk-abc123"`

#### Scenario: Literal value

- **WHEN** a config value is `"sk-abc123"` and no env var named `sk-abc123` exists
- **THEN** the resolved value SHALL be `"sk-abc123"`

#### Scenario: Shell command fails

- **WHEN** a shell command returns non-zero exit code or times out
- **THEN** the resolved value SHALL be `undefined`

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

### Requirement: JSON5 config file format

The system SHALL parse the config file using JSON5, supporting comments, trailing commas, and unquoted keys.

#### Scenario: Config with comments and trailing commas

- **WHEN** `goblin.json5` contains `// comments` and trailing commas
- **THEN** the file SHALL parse successfully

### Requirement: Unified log level source

`log.ts` SHALL receive its log level from the `Config` object rather than reading `process.env.LOG_LEVEL` directly. The log module MUST be initialized after config loading.

#### Scenario: Log level from config file

- **WHEN** `goblin.json5` contains `logLevel: "debug"`
- **THEN** the logger SHALL use debug-level threshold



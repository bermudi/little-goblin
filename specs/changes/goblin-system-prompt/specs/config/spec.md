# config

## MODIFIED Requirements

### Requirement: Validate config with Zod schema

The system SHALL validate the fully-resolved config object against a Zod schema. Validation failures SHALL cause a startup error with Zod's formatted error output. The `skillSources` field SHALL accept only `"goblin-only"` and `"user"`, defaulting to `"goblin-only"` when absent. The removed value `"auto"` MUST fail config validation.

#### Scenario: skillSources default

- **WHEN** `skillSources` is absent from `goblin.json5`
- **THEN** the loaded config SHALL use `"goblin-only"`

#### Scenario: valid skillSources values

- **WHEN** `skillSources` is `"goblin-only"` or `"user"`
- **THEN** config validation SHALL pass

#### Scenario: auto rejected

- **WHEN** `skillSources` is `"auto"`
- **THEN** config validation SHALL fail

#### Scenario: Invalid model name type

- **WHEN** `model` is set to a number instead of a string
- **THEN** Zod validation SHALL reject with a type error

#### Scenario: Invalid log level

- **WHEN** `logLevel` is set to `"verbose"` (not in the enum)
- **THEN** Zod validation SHALL reject with an enum error

#### Scenario: Valid config passes

- **WHEN** all required fields are present and correctly typed after resolution
- **THEN** `loadConfig()` SHALL return a valid `Config` object

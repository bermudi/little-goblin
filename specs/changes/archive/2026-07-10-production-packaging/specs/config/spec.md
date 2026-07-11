# config

## ADDED Requirements

### Requirement: Provide a non-interactive config validation command

The system SHALL expose `bun run validate-config` that loads `goblin.json5`, resolves all values, validates the schema, and reports whether the current configuration is ready to start the bot.

#### Scenario: Valid config

- **WHEN** `bun run validate-config` is run with a valid `goblin.json5`
- **THEN** it SHALL print a success message and exit with code 0

#### Scenario: Invalid config

- **WHEN** `bun run validate-config` is run with a missing required field or invalid schema
- **THEN** it SHALL print the specific validation error and exit with a non-zero code

#### Scenario: Unresolvable value

- **WHEN** `bun run validate-config` is run with a config value that references an unset env var or a failing shell command
- **THEN** it SHALL report the unresolvable value by path and exit with a non-zero code

## ADDED Requirements

### Requirement: Preflight check validates required model credentials

The system SHALL verify at startup that the API key required by the selected model is present and resolvable after value resolution.

#### Scenario: Poe model without poeApiKey

- **WHEN** the selected model is a Poe model and `poeApiKey` is missing or unresolvable
- **THEN** the preflight check SHALL fail with a clear message naming the missing key

#### Scenario: Matching key is present

- **WHEN** the selected model requires `openrouterApiKey` and the key is present and resolvable
- **THEN** the preflight check SHALL pass that credential check

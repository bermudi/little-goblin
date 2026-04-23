# logging

## Requirements

### Requirement: Support configurable log levels

The system SHALL support log level filtering via the `LOG_LEVEL` environment variable, defaulting to "info".

#### Scenario: Valid log level set

- **WHEN** `LOG_LEVEL` is set to "debug", "info", "warn", or "error"
- **THEN** only messages at that level or higher severity SHALL be emitted

#### Scenario: Invalid log level set

- **WHEN** `LOG_LEVEL` is set to an invalid value (e.g., "verbose")
- **THEN** a warning SHALL be written to stderr: `Invalid LOG_LEVEL="verbose". Valid: debug, info, warn, error. Falling back to "info".`
- **AND** the system SHALL fall back to "info" level

#### Scenario: LOG_LEVEL not set

- **WHEN** `LOG_LEVEL` is not defined
- **THEN** the system SHALL default to "info" level without warning

### Requirement: Format log output with timestamp and level

The system SHALL format log messages as: `<ISO8601> <LEVEL> <message>` with optional JSON extra data.

#### Scenario: Simple log message

- **WHEN** `log.info("starting up")` is called
- **THEN** output SHALL match format: `2024-01-15T10:30:00.000Z INFO  starting up\n`

#### Scenario: Log with extra data

- **WHEN** `log.info("session created", { id: "abc123" })` is called
- **THEN** output SHALL include the extra data as JSON: `... INFO  session created {"id":"abc123"}\n`

### Requirement: Route errors and warnings to stderr

The system SHALL write "error" and "warn" level messages to stderr, and "debug" and "info" to stdout.

#### Scenario: Error logging

- **WHEN** `log.error("connection failed")` is called
- **THEN** the message SHALL be written to stderr

#### Scenario: Info logging

- **WHEN** `log.info("server started")` is called
- **THEN** the message SHALL be written to stdout

### Requirement: Provide leveled log functions

The system SHALL export a `log` object with methods for each level: `debug()`, `info()`, `warn()`, `error()`.

#### Scenario: Module imports log

- **WHEN** a module imports `{ log }` from `"./log.ts"`
- **THEN** it SHALL be able to call `log.debug()`, `log.info()`, `log.warn()`, `log.error()`

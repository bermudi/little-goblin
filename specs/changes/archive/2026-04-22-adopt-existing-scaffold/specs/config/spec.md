# config

## ADDED Requirements

### Requirement: Load required environment variables
The system SHALL validate and load required environment variables at startup, throwing clear errors for missing or invalid values.

#### Scenario: BOT_TOKEN missing
- **WHEN** `BOT_TOKEN` is not set in environment
- **THEN** `loadConfig()` SHALL throw `Error: Missing required env var: BOT_TOKEN`

#### Scenario: ALLOWED_TG_USER_IDS missing
- **WHEN** `ALLOWED_TG_USER_IDS` is not set
- **THEN** `loadConfig()` SHALL throw `Error: Missing required env var: ALLOWED_TG_USER_IDS`

#### Scenario: ALLOWED_TG_USER_IDS empty
- **WHEN** `ALLOWED_TG_USER_IDS` is set to empty string or contains only whitespace
- **THEN** `loadConfig()` SHALL throw `Error: ALLOWED_TG_USER_IDS must contain at least one id`

#### Scenario: ALLOWED_TG_USER_IDS contains non-integer
- **WHEN** `ALLOWED_TG_USER_IDS` contains a value that is not an integer (e.g., "abc")
- **THEN** `loadConfig()` SHALL throw `Error: ALLOWED_TG_USER_IDS: "abc" is not an integer`

#### Scenario: MODEL_NAME missing
- **WHEN** `MODEL_NAME` is not set
- **THEN** `loadConfig()` SHALL throw `Error: Missing required env var: MODEL_NAME`

### Requirement: Parse ALLOWED_TG_USER_IDS as comma-separated set
The system SHALL parse `ALLOWED_TG_USER_IDS` as a comma-separated list of Telegram user IDs, trimming whitespace and storing as a `Set<number>`.

#### Scenario: Multiple valid IDs
- **WHEN** `ALLOWED_TG_USER_IDS` is set to "123, 456 ,789"
- **THEN** the resulting `allowedTgUserIds` SHALL be a Set containing [123, 456, 789]

### Requirement: Load optional environment variables with defaults
The system SHALL load optional environment variables with sensible defaults.

#### Scenario: GOBLIN_HOME defaults to ~/goblin
- **WHEN** `GOBLIN_HOME` is not set
- **THEN** `goblinHome` SHALL default to `$HOME/goblin` (or equivalent on platform)

#### Scenario: Optional API keys unset
- **WHEN** `POE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` are not set
- **THEN** the corresponding config fields SHALL be `undefined`

### Requirement: Ensure GOBLIN_HOME directory structure
The system SHALL create required subdirectories under `GOBLIN_HOME` at startup.

#### Scenario: First run with empty GOBLIN_HOME
- **WHEN** `ensureGoblinHome()` is called with a fresh directory
- **THEN** it SHALL create `GOBLIN_HOME/`, `GOBLIN_HOME/sessions/`, and `GOBLIN_HOME/skills/` directories

#### Scenario: Directories already exist
- **WHEN** `ensureGoblinHome()` is called and directories already exist
- **THEN** it SHALL complete without error (idempotent)

### Requirement: Expose typed Config interface
The system SHALL expose a `Config` interface with all configuration fields typed explicitly.

#### Scenario: Config consumer accesses fields
- **WHEN** a module imports `Config` type
- **THEN** it SHALL have access to: `botToken`, `allowedTgUserIds`, `modelName`, `poeApiKey?`, `openrouterApiKey?`, `openaiApiKey?`, `anthropicApiKey?`, `goblinHome`

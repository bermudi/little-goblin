# config

## Requirements

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

### Requirement: Ensure GOBLIN_HOME directory structure

The system SHALL create required subdirectories under `GOBLIN_HOME` at startup.

#### Scenario: First run with empty GOBLIN_HOME

- **WHEN** `ensureGoblinHome()` is called with a fresh directory
- **THEN** it SHALL create `GOBLIN_HOME/`, `GOBLIN_HOME/sessions/`, and `GOBLIN_HOME/skills/` directories

#### Scenario: Directories already exist

- **WHEN** `ensureGoblinHome()` is called and directories already exist
- **THEN** it SHALL complete without error (idempotent)

### Requirement: Expose typed Config interface

The system SHALL expose a `Config` interface with all configuration fields typed explicitly, derived from the Zod schema.

#### Scenario: Config consumer accesses fields

- **WHEN** a module imports `Config` type
- **THEN** it SHALL have access to: `botToken`, `allowedTgUserIds`, `modelName`, `poeApiKey?`, `openrouterApiKey?`, `openaiApiKey?`, `anthropicApiKey?`, `goblinHome`, `logLevel`, `skillSources`

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

### Requirement: VOICE_NAME configures Edge TTS voice

The system SHALL accept an optional `VOICE_NAME` environment variable specifying the Microsoft Edge TTS voice to use for the `/voice` command and `text_to_speech` tool. When absent, the voice SHALL default to `en-US-EmmaMultilingualNeural`. The value SHALL be a valid Edge TTS voice name (e.g. `en-US-AndrewMultilingualNeural`, `en-US-AnaNeural`). Validation of the voice name is deferred to `edge-tts` at invocation time — invalid names produce a clear error from the subprocess.

#### Scenario: VOICE_NAME not set

- **WHEN** the `VOICE_NAME` environment variable is not present
- **THEN** the `/voice` command and `text_to_speech` tool SHALL use `en-US-EmmaMultilingualNeural`

#### Scenario: VOICE_NAME set to a male voice

- **WHEN** `VOICE_NAME=en-US-AndrewMultilingualNeural`
- **THEN** both `/voice` and `text_to_speech` SHALL pass `--voice en-US-AndrewMultilingualNeural` to `uvx edge-tts`

### Requirement: Edge TTS availability checked at startup

The system SHALL verify that `uvx edge-tts` is callable during startup by running `uvx edge-tts --version`. If the check fails, the system SHALL log a warning and continue — the bot operates without voice capability, and `/voice` or `text_to_speech` will fail with a clear error at invocation time.

#### Scenario: edge-tts available at startup

- **WHEN** `uvx edge-tts --version` exits successfully
- **THEN** the system SHALL proceed normally

#### Scenario: edge-tts not available at startup

- **WHEN** `uvx edge-tts --version` fails (command not found, Python missing, etc.)
- **THEN** the system SHALL log a warning including the error
- **AND** the bot SHALL start normally
- **AND** subsequent `/voice` or `text_to_speech` calls SHALL fail with a clear error message

### Requirement: Groq ASR configuration

The config file SHALL accept optional Groq ASR settings for Telegram voice transcription. `groqApiKey` SHALL be an optional resolved string. `asrModel` SHALL be optional and SHALL accept only `whisper-large-v3-turbo` or `whisper-large-v3`, defaulting to `whisper-large-v3-turbo` when absent. The loaded `Config` object SHALL expose `groqApiKey?: string` and `asrModel: "whisper-large-v3-turbo" | "whisper-large-v3"`.

#### Scenario: Default ASR model

- **WHEN** `goblin.json5` omits `asrModel`
- **THEN** `loadConfig()` SHALL return `asrModel = "whisper-large-v3-turbo"`

#### Scenario: Groq key resolved from environment

- **WHEN** `goblin.json5` contains `groqApiKey: "GROQ_API_KEY"`
- **AND** `process.env.GROQ_API_KEY` is set
- **THEN** `loadConfig()` SHALL resolve and expose the API key on `Config.groqApiKey`

#### Scenario: Unresolved Groq key env reference

- **WHEN** `goblin.json5` contains `groqApiKey: "GROQ_API_KEY"`
- **AND** `process.env.GROQ_API_KEY` is unset
- **THEN** `loadConfig()` SHALL succeed
- **AND** `Config.groqApiKey` SHALL be unset
- **AND** voice transcription SHALL fail at use time with the setup message, not at startup

#### Scenario: Invalid ASR model rejected

- **WHEN** `goblin.json5` contains `asrModel: "whisper-1"`
- **THEN** config validation SHALL fail with an enum error

### Requirement: Groq ASR setup failure does not block startup

Missing `groqApiKey` SHALL NOT fail startup. Telegram voice transcription SHALL fail at use time with a clear setup message when the key is absent, while the rest of the bot continues to operate normally.

#### Scenario: Missing Groq key starts bot

- **WHEN** `groqApiKey` is absent from `goblin.json5`
- **THEN** `loadConfig()` SHALL succeed
- **AND** the resulting config SHALL have no `groqApiKey`

#### Scenario: Missing Groq key during voice use

- **WHEN** a Telegram voice message is handled and `Config.groqApiKey` is absent
- **THEN** Goblin SHALL reply with a clear message that Groq ASR is not configured
- **AND** SHALL NOT include any API key value in logs or replies

# config

## ADDED Requirements

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

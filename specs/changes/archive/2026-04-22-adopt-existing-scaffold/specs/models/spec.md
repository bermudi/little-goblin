# models

## ADDED Requirements

### Requirement: Define model registry with prefixed IDs
The system SHALL maintain a registry `MODELS` mapping prefixed model IDs to provider configurations.

#### Scenario: Registry accessed
- **WHEN** `MODELS` is accessed
- **THEN** it SHALL contain entries for supported models with keys like `poe/Claude-Sonnet-4.6`, `or/anthropic/claude-sonnet-4.5`, `openai/gpt-5.4`, `anthropic/claude-opus-4`

### Requirement: Associate models with API key environment variables
Each model entry SHALL specify which environment variable provides the API key.

#### Scenario: Poe model entry
- **WHEN** accessing a Poe model entry
- **THEN** its `apiKeyEnv` SHALL be `"POE_API_KEY"`

#### Scenario: OpenRouter model entry
- **WHEN** accessing an OpenRouter model entry
- **THEN** its `apiKeyEnv` SHALL be `"OPENROUTER_API_KEY"`

#### Scenario: Direct OpenAI model entry
- **WHEN** accessing a direct OpenAI model entry
- **THEN** its `apiKeyEnv` SHALL be `"OPENAI_API_KEY"`

#### Scenario: Direct Anthropic model entry
- **WHEN** accessing a direct Anthropic model entry
- **THEN** its `apiKeyEnv` SHALL be `"ANTHROPIC_API_KEY"`

### Requirement: Resolve model and API key from Config
The system SHALL look up the configured model and validate the corresponding API key is present.

#### Scenario: Valid model with matching API key
- **WHEN** `resolveModel()` is called with a Config where `modelName` exists in MODELS and the corresponding API key is set
- **THEN** it SHALL return `{ model: Model<Api>, apiKey: string }`

#### Scenario: Unknown model name
- **WHEN** `resolveModel()` is called with a `modelName` not in MODELS
- **THEN** it SHALL throw `Error: Unknown MODEL_NAME "<name>". Known: <list>`

#### Scenario: Model requires missing API key
- **WHEN** `resolveModel()` is called and the model's required API key env var is not set in config
- **THEN** it SHALL throw `Error: MODEL_NAME "<name>" requires <API_KEY_ENV> to be set`

### Requirement: Define model entry TypeScript interface
The system SHALL export a `ModelEntry` interface describing model configuration.

#### Scenario: Type usage
- **WHEN** importing `ModelEntry` from `"./agent/models.ts"`
- **THEN** it SHALL have fields: `model: Model<Api>`, `apiKeyEnv: ApiKeyEnv`

### Requirement: Export API key environment variable union type
The system SHALL export `ApiKeyEnv` as a union of valid API key environment variable names.

#### Scenario: Type check
- **WHEN** using `ApiKeyEnv` type
- **THEN** valid values SHALL be: `"POE_API_KEY"`, `"OPENROUTER_API_KEY"`, `"OPENAI_API_KEY"`, `"ANTHROPIC_API_KEY"`

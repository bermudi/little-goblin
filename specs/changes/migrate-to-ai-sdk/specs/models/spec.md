# models

## MODIFIED Requirements

### Requirement: Define model registry with prefixed IDs

The system SHALL maintain a registry `MODELS` mapping prefixed model IDs to AI SDK provider constructors and configuration. Each entry SHALL specify the AI SDK provider function to use and the model ID string to pass to it.

#### Scenario: Registry accessed

- **WHEN** `MODELS` is accessed
- **THEN** it SHALL contain entries for supported models with keys like `poe/gemini-2.5-pro`, `or/anthropic/claude-sonnet-4.5`, `openai/gpt-5.4`, `anthropic/claude-opus-4`

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

The system SHALL look up the configured model and validate the corresponding API key is present. It SHALL return an AI SDK `LanguageModel` instance ready for use with `streamText()` / `generateText()`.

#### Scenario: Valid model with matching API key

- **WHEN** `resolveModel()` is called with a Config where `modelName` exists in MODELS and the corresponding API key is set
- **THEN** it SHALL return `{ model: LanguageModel, apiKey: string }`

#### Scenario: Unknown model name

- **WHEN** `resolveModel()` is called with a `modelName` not in MODELS and not matching any provider prefix pattern
- **THEN** it SHALL throw `Error: Unknown MODEL_NAME "<name>". Known: <list>`

#### Scenario: Model requires missing API key

- **WHEN** `resolveModel()` is called and the model's required API key env var is not set in config
- **THEN** it SHALL throw `Error: MODEL_NAME "<name>" requires <API_KEY_ENV> to be set`

### Requirement: Define model entry TypeScript interface

The system SHALL export a `ModelEntry` interface describing model configuration using AI SDK types.

#### Scenario: Type usage

- **WHEN** importing `ModelEntry` from `"./agent/models.ts"`
- **THEN** it SHALL have fields for the provider constructor, model ID, API key env, and optional thinking level configuration

### Requirement: Export API key environment variable union type

The system SHALL export `ApiKeyEnv` as a union of valid API key environment variable names.

#### Scenario: Type check

- **WHEN** using `ApiKeyEnv` type
- **THEN** valid values SHALL include: `"POE_API_KEY"`, `"OPENROUTER_API_KEY"`, `"OPENAI_API_KEY"`, `"ANTHROPIC_API_KEY"`, `"ZAI_API_KEY"`

## ADDED Requirements

### Requirement: Provider prefix pattern matching for unregistered models

The system SHALL support dynamic model resolution for provider-prefixed IDs that are not in the static `MODELS` registry. Pattern matching rules:

- `poe/<id>` → construct a Poe provider with the model ID
- `or/<slug>` → construct an OpenRouter provider with the slug
- `openai/<id>` → construct an OpenAI provider with the ID
- `anthropic/<id>` → construct an Anthropic provider with the ID
- `zai/<id>` → construct a Z.AI provider with the ID

#### Scenario: Poe model not in registry

- **WHEN** `resolveModel()` is called with `modelName = "poe/some-new-model"`
- **THEN** a provider SHALL be constructed dynamically using the Poe base URL and API key
- **AND** the returned `LanguageModel` SHALL be usable with AI SDK calls

#### Scenario: OpenRouter slug not in registry

- **WHEN** `resolveModel()` is called with `modelName = "or/some/provider-model"`
- **THEN** an OpenRouter provider SHALL be constructed dynamically
- **AND** the model ID passed to the provider SHALL be `"some/provider-model"`

### Requirement: Thinking level configuration per model

The system SHALL support per-model thinking level configuration. When a model supports reasoning, the resolved model entry SHALL carry the default thinking level. The system SHALL export a `clampThinkingLevel()` function that clamps a user-selected thinking level to the valid range for a given model family.

#### Scenario: High thinking level for Anthropic models

- **WHEN** an Anthropic model is resolved
- **THEN** the default thinking level SHALL be `"high"`

#### Scenario: Medium thinking level for OpenAI models

- **WHEN** an OpenAI reasoning model is resolved
- **THEN** the default thinking level SHALL be `"medium"`

#### Scenario: Clamp invalid thinking level

- **WHEN** `clampThinkingLevel("xhigh", modelId)` is called for a model that caps at "high"
- **THEN** it SHALL return `"high"`

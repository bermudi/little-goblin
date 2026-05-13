# models

## ADDED Requirements

### Requirement: Poe model catalog cache

The system SHALL fetch Poe's `GET /v1/models` endpoint once at startup and cache the response in memory. The cached catalog SHALL be used to resolve any `poe/*` model name.

#### Scenario: Startup fetch succeeds

- **WHEN** goblin starts with a `poe/*` model configured (or Poe API key present)
- **THEN** the system SHALL fetch `https://api.poe.com/v1/models` and cache the response
- **AND** the fetch SHALL time out after 10 seconds

#### Scenario: Startup fetch fails

- **WHEN** the catalog fetch fails (network error, non-2xx, timeout)
- **THEN** the system SHALL log a warning and continue
- **AND** subsequent `poe/*` model resolution SHALL fall back to pattern matching with hardcoded defaults

#### Scenario: Catalog returns empty model list

- **WHEN** the catalog fetch succeeds but returns zero models in `data`
- **THEN** the system SHALL log a warning and treat the catalog as unavailable
- **AND** subsequent `poe/*` model resolution SHALL fall back to pattern matching with hardcoded defaults

#### Scenario: Catalog response structure

- **WHEN** the catalog is fetched successfully
- **THEN** each entry SHALL be indexed by `id` (lowercase Poe model identifier)
- **AND** the system SHALL extract: `architecture.input_modalities`, `context_window.context_length`, `parameters[].max_output_tokens.maximum`, `pricing`, `owned_by`

### Requirement: Dynamic Poe model resolution from catalog

For any `poe/*` model name, the system SHALL resolve the `Model<Api>` object from the cached Poe catalog. When the catalog is unavailable, the system SHALL fall back to pattern matching with hardcoded defaults.

#### Scenario: Known Poe model with full catalog data

- **WHEN** `resolveModel()` is called with `modelName = "poe/claude-sonnet-4.6"` and the catalog contains an entry with `id: "claude-sonnet-4.6"`
- **THEN** the returned `Model.input` SHALL be derived from `architecture.input_modalities`, including only `"text"` and `"image"`; other modalities (e.g. `"audio"`, `"video"`) SHALL be silently dropped
- **AND** `Model.contextWindow` SHALL be derived from `context_window.context_length`
- **AND** `Model.maxTokens` SHALL be derived using the fallback chain: `parameters[].max_output_tokens.maximum` (authoritative) → `context_window.max_output_tokens` → `resolveMaxTokens(id)` → hardcoded `8_192`
- **AND** `Model.cost` SHALL be derived from `pricing` fields (informational only; exact billing is provider-dependent)
- **AND** `Model.reasoning` SHALL be `true` for Anthropic and OpenAI families, `false` for all others

#### Scenario: Non-vision Poe model

- **WHEN** `resolveModel()` is called with `modelName = "poe/gpt-5.3-codex-spark"` and the catalog entry has `input_modalities: ["text"]`
- **THEN** the returned `Model.input` SHALL be `["text"]`
- **AND** pi's `downgradeUnsupportedImages()` SHALL handle image content correctly

#### Scenario: Poe model with null catalog fields

- **WHEN** a Poe model's catalog entry has null or missing `context_window` or `parameters`
- **THEN** `Model.contextWindow` SHALL default to `128_000`
- **AND** `Model.maxTokens` SHALL use the fallback chain: `resolveMaxTokens(id)` → hardcoded `8_192`

#### Scenario: Poe model not in catalog

- **WHEN** `resolveModel()` is called with `modelName = "poe/some-unknown-bot"` and the catalog has no matching entry
- **THEN** the system SHALL throw an error listing up to 5 close-match suggestions from the catalog
- **AND** the error message SHALL include the Poe model id prefix

#### Scenario: Catalog unavailable, fallback to pattern matching

- **WHEN** `resolveModel()` is called with `modelName = "poe/claude-sonnet-4.6"` and the catalog is unavailable (fetch failed or empty)
- **THEN** the system SHALL fall back to pattern matching: `claude-*` → `anthropic` API with hardcoded `input: ["text", "image"]`, `gpt-*` / `o[0-9]*` → `openai-responses`, everything else → `openai-completions`
- **AND** the system SHALL log a warning that catalog-derived capabilities are unavailable

### Requirement: Poe API dialect routing from owned_by

The system SHALL determine the pi-ai `api` dialect for Poe models from the catalog's `owned_by` field. When the active model has an unrecognized `owned_by` value, the system SHALL emit a startup warning.

#### Scenario: Anthropic-owned model

- **WHEN** a Poe model has `owned_by: "Anthropic"`
- **THEN** `Model.api` SHALL be `"anthropic"` and `Model.baseUrl` SHALL be `"https://api.poe.com"`
- **AND** `Model.reasoning` SHALL be `true`

#### Scenario: OpenAI-owned model

- **WHEN** a Poe model has `owned_by: "OpenAI"`
- **THEN** `Model.api` SHALL be `"openai-responses"` and `Model.baseUrl` SHALL be `"https://api.poe.com/v1"`
- **AND** `Model.reasoning` SHALL be `true`

#### Scenario: Any other provider

- **WHEN** a Poe model has `owned_by` set to any other value (e.g. `"Google"`, `"xAI"`, `"Novita AI"`)
- **THEN** `Model.api` SHALL be `"openai-completions"` and `Model.baseUrl` SHALL be `"https://api.poe.com/v1"`
- **AND** `Model.reasoning` SHALL be `false`

#### Scenario: Unrecognized owned_by for active model

- **WHEN** the configured `poe/*` model has `owned_by` not equal to `"Anthropic"` or `"OpenAI"`
- **THEN** the system SHALL log a warning at startup: `"Poe model '<id>' has unrecognized provider '<owned_by>'; defaulting to openai-completions"`

### Requirement: Poe model overrides via POE_OVERRIDES record

The system SHALL export a separate `POE_OVERRIDES` record (type `Record<string, Partial<Pick<Model<Api>, "contextWindow" | "maxTokens">>>)`. When an override exists for a Poe model, the override fields SHALL take precedence over catalog-derived values. The catalog SHALL remain the source of truth for `input`, `cost`, `name`, `api`, `reasoning`, and all other fields not listed in the override type.

#### Scenario: Override for context window

- **WHEN** `POE_OVERRIDES["poe/gemini-2.5-pro"]` exists with `{ contextWindow: 1_000_000 }` and the catalog reports a different value
- **THEN** the override value `1_000_000` SHALL be used for `Model.contextWindow`
- **AND** `Model.input` SHALL still come from the catalog

#### Scenario: No override for a Poe model

- **WHEN** `POE_OVERRIDES` has no entry for `poe/claude-sonnet-4.6`
- **THEN** all `Model` fields SHALL come from the catalog

#### Scenario: Override type safety

- **WHEN** a developer adds an entry to `POE_OVERRIDES`
- **THEN** TypeScript SHALL enforce that only `contextWindow` and `maxTokens` are overridable

## MODIFIED Requirements

### Requirement: Define model registry with prefixed IDs

The system SHALL maintain a registry `MODELS` mapping non-Poe prefixed model IDs to provider configurations. Poe model overrides SHALL live in a separate `POE_OVERRIDES` record.

#### Scenario: Registry accessed

- **WHEN** `MODELS` is accessed
- **THEN** it SHALL contain entries for non-Poe models: `or/anthropic/claude-sonnet-4.5`, `openai/gpt-5.4`, `anthropic/claude-opus-4`, etc.
- **AND** it SHALL NOT contain any `poe/*` entries

### Requirement: Resolve model and API key from Config

The system SHALL resolve `poe/*` models from the cached Poe catalog (with pattern matching fallback) and non-Poe models from the static `MODELS` record or pattern matching.

#### Scenario: Valid Poe model resolved from catalog

- **WHEN** `resolveModel()` is called with a `poe/*` modelName found in the cached catalog
- **THEN** it SHALL return `{ model: Model<Api>, apiKey: string }` with fields derived from catalog data

#### Scenario: Poe model resolved via fallback pattern matching

- **WHEN** `resolveModel()` is called with a `poe/*` modelName and the catalog is unavailable
- **THEN** it SHALL return `{ model: Model<Api>, apiKey: string }` with hardcoded defaults from pattern matching

#### Scenario: Unknown model name (not Poe, not in registry)

- **WHEN** `resolveModel()` is called with a `modelName` that is not `poe/*` and not in `MODELS`
- **THEN** it SHALL throw `Error: Unknown MODEL_NAME "<name>". Known: <list>`

#### Scenario: Model requires missing API key

- **WHEN** `resolveModel()` is called and the model's required API key env var is not set in config
- **THEN** it SHALL throw `Error: MODEL_NAME "<name>" requires <API_KEY_ENV> to be set`

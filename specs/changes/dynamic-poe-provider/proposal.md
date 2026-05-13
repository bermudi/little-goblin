## Motivation

Goblin's model registry hardcodes every Poe model's capabilities as `input: ["text", "image"]`. When a non-vision model (e.g. `gpt-5.3-codex-spark`) is used, sending an image crashes with `404 No endpoints found that support image input` from Poe's API. Pi's built-in `downgradeUnsupportedImages()` never kicks in because goblin lied about the model's capabilities.

Meanwhile, Poe's `GET /v1/models` catalog already exposes `architecture.input_modalities`, `context_window`, `max_output_tokens`, and `pricing` per model. Goblin already fetches this endpoint at startup for validation — but throws the data away.

The static registry also means new Poe models require code changes. Goblin should discover models dynamically from the catalog.

## Scope

- **Replace static Poe model entries with dynamic catalog resolution.** At startup, fetch `GET /v1/models`, cache the response, and build `Model<Api>` objects from the catalog data for any `poe/*` model name.
- **Accurate `input` array.** Map `architecture.input_modalities` from the Poe catalog to pi's `Model.input` field. Non-vision models get `["text"]`.
- **Accurate `contextWindow` and `maxTokens`.** From `context_window.context_length` and `parameters[].max_output_tokens.maximum`.
- **Accurate `cost`.** From `pricing` fields in the catalog.
- **API dialect routing stays pattern-based.** `owned_by: "Anthropic"` → `anthropic` API, `owned_by: "OpenAI"` → `openai-responses` API, everything else → `openai-completions`. All models support chat completions; Anthropic and OpenAI families get their native dialects.
- **`MODELS` record becomes override-only for Poe.** Only entries that need context window overrides or dialect pins remain. Pattern matching (`poePatternMatch`) is replaced by catalog lookup.
- **Startup validation folds into catalog fetch.** `poe-validate.ts` is replaced — the catalog fetch validates existence as a side effect.
- **Remove `ModelNotCapableError`.** Once `Model.input` is accurate, pi's `downgradeUnsupportedImages()` handles image rejection automatically. If a nicer user-facing error is wanted, that's a separate concern.

### Affected capabilities

- `models` — model registry and resolution
- `agent` — `AgentRunner` no longer needs `ModelNotCapableError`

## Non-Goals

- **Non-Poe provider changes.** OpenRouter, direct OpenAI, direct Anthropic entries stay static — they don't have a unified catalog endpoint.
- **Model switching at runtime.** This change resolves the model at startup (same as today). Hot-reloading the catalog on `/model` switch is a separate enhancement.
- **User-facing error messages for image rejection.** Pi silently replaces images with `"(image omitted)"`. A nicer UX layer can be added later.
- **Caching strategy beyond startup.** The catalog is fetched once at startup. TTL-based refresh or on-demand revalidation is future work.
- **`reasoning` field from catalog.** Poe doesn't expose this directly. It stays pattern-derived.

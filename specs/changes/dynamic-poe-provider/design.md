## Architecture

```
Startup
  │
  ├─ initPoeCatalog(cfg, logger)  ←── GET https://api.poe.com/v1/models
  │   ├─ success → PoeCatalog (Map<id, PoeModelInfo>) cached in memory
  │   └─ failure → catalog = null, log warning
  │
  ├─ resolveModel(cfg)
  │   ├─ poe/* → resolvePoeModel(id, catalog, overrides)
  │   │   ├─ catalog available + hit → build Model<Api> from catalog data
  │   │   │   └─ apply POE_OVERRIDES if present
  │   │   ├─ catalog available + miss → throw with suggestions
  │   │   └─ catalog null → fall back to poePatternMatch() (hardcoded defaults)
  │   ├─ or/* → openrouterPatternMatch (unchanged)
  │   ├─ openai/* → directOpenAIPatternMatch (unchanged)
  │   └─ anthropic/* → directAnthropicPatternMatch (unchanged)
  │
  └─ AgentRunner.init() uses resolved.model
      └─ pi's downgradeUnsupportedImages() now works correctly
```

The catalog is the primary resolution path for `poe/*` models. Pattern matching is preserved as a fallback for when the catalog is unavailable.

## Decisions

### Catalog is fetched once at startup, not on-demand

**Chosen:** Eager fetch during startup, cached for process lifetime.

**Why not on-demand:** Poe's docs say "cache for 1–24 hours." A startup fetch is the simplest correct choice. Model switching during a session already resolves at `init()` time. A TTL cache adds complexity for no immediate benefit.

**Why not on every resolve:** Latency. The catalog is large (hundreds of models). One fetch at startup is enough.

**Assumption:** Goblin is a single-user, single-process homelab bot. Process restarts are cheap.

### Pattern matching preserved as catalog-unavailable fallback

**Chosen:** `poePatternMatch()` and its factory functions (`poeAnthropic`, `poeResponses`, `poeCompletions`) are kept in `models.ts` but only invoked when the catalog is `null`.

**Why not remove entirely:** The spec requires graceful degradation when the catalog fetch fails. Pattern matching with hardcoded `input: ["text", "image"]` is imperfect but better than a fatal error. A homelab bot shouldn't brick because Poe had a 5-second blip.

**Trade-off:** When falling back, capabilities are inaccurate (same bug as today). Acceptable because the fallback is a degraded mode, not the normal path.

### API dialect derived from `owned_by`

**Chosen:** `owned_by: "Anthropic"` → `anthropic` API, `owned_by: "OpenAI"` → `openai-responses`, everything else → `openai-completions`.

**Why not from `supported_endpoints`:** The Poe skill docs note that `supported_endpoints` is unreliable — many models with empty arrays still work via chat completions. `owned_by` is the most reliable proxy for the best API dialect.

**Unknown provider detection:** When the configured model has an unrecognized `owned_by` (not `"Anthropic"` or `"OpenAI"`), the system logs a startup warning. This surfaces the issue without blocking startup.

**Trade-off:** If Poe changes `"OpenAI"` to `"Open AI"` or adds a provider whose native API isn't anthropic/openai-completions, the model routes to `openai-completions` (the else case). The startup warning catches this for the active model.

### `POE_OVERRIDES` record is a separate, typed map

**Chosen:** A dedicated `POE_OVERRIDES: Record<string, Partial<Pick<Model<Api>, "contextWindow" | "maxTokens">>>` record, separate from `MODELS`.

**Why not put overrides in `MODELS`:** `MODELS` entries are full `ModelEntry` objects (model + apiKeyEnv). Poe overrides are partial — only `contextWindow` and `maxTokens`. Mixing them in one record creates a union type where every consumer has to check which kind of entry it got. A separate record is type-safe and unambiguous.

**Why not include `api` in overrides:** Overriding API dialect for Poe models is dangerous — Poe's API rejects requests sent to the wrong endpoint. The `owned_by` routing is correct for all known models. If a concrete need arises, `api` can be added to the override type later.

**Why `contextWindow` and `maxTokens` only:** Some models (e.g. `gemini-2.5-pro`) have context windows larger than what the catalog reports. These are the only fields where we've needed manual correction.

### `maxTokens` fallback chain is catalog-first

**Chosen:** `parameters[].max_output_tokens.maximum` → `context_window.max_output_tokens` → `resolveMaxTokens(id)` → hardcoded `8_192`.

**Why not just `resolveMaxTokens`:** `resolveMaxTokens` queries pi-ai's built-in model database, which may not have every Poe model. The catalog's own fields are more authoritative for Poe models. `resolveMaxTokens` is a third-level fallback for models not in either source.

### `ModelNotCapableError` removed

**Chosen:** Remove the class and the capability check in `AgentRunner.prompt()`.

**Why:** Once `Model.input` is accurate, pi's `downgradeUnsupportedImages()` replaces images with `"(image omitted)"` automatically. No crash, no session poisoning. The explicit error was a workaround for goblin lying about capabilities — the lie is now fixed at the source.

**Trade-off:** Users get silent image omission instead of an explicit error message. The photo handler catch block in `bot.ts` retains a generic error reply (`⚠️ Failed to process image.`) so non-capability errors are still surfaced.

### `reasoning` field stays pattern-derived

**Chosen:** `reasoning: true` for Anthropic and OpenAI families, `false` for everything else. Same as today.

**Why not from catalog:** Poe doesn't expose a `supports_reasoning` field. The `supported_features` array doesn't include a reasoning flag.

### Cost asymmetry between Poe and non-Poe providers

Poe models get real pricing from the catalog. Non-Poe models (OpenRouter, direct OpenAI, direct Anthropic) still use `ZERO_COST` placeholders. This is acceptable because cost is informational only — actual billing is provider-dependent and goblin doesn't use cost for any behavioral decisions.

### `poe-validate.ts` replaced by catalog fetch

**Chosen:** The catalog fetch subsumes startup validation. If the model isn't in the catalog, resolution throws with close-match suggestions — the same behavior as the current validator.

**Why not keep both:** Redundant. One fetch, one validation path.

### Logger interface for catalog functions

**Chosen:** `{ warn: (msg: string, ctx?: Record<string, unknown>) => void }` — matches the existing `log` object used by `validateModelAtStartup`.

## File Changes

### `src/agent/poe-catalog.ts` — New file

- **Add:** `PoeModelInfo` interface — shape extracted from catalog response (`id`, `owned_by`, `architecture.input_modalities`, `context_window`, `parameters`, `pricing`)
- **Add:** `PoeCatalog` type — `Map<string, PoeModelInfo> | null`
- **Add:** `fetchPoeCatalog(cfg, logger)` — fetches `GET /v1/models`, parses into `Map<string, PoeModelInfo>`, 10s timeout, returns `null` on failure, logs warning on empty data
- **Add:** `initPoeCatalog(cfg, logger)` — calls `fetchPoeCatalog`, stores result in module-level variable
- **Add:** `getPoeCatalog()` — returns the cached catalog (or `null`)
- **Add:** `buildModelFromCatalog(id, info)` — converts a catalog entry to `Model<Api>` using `owned_by` routing, maps `input_modalities` (filtering to `"text"` | `"image"` only), maps `context_window` / `parameters` / `pricing`
- **Add:** `resolvePoeModel(id, catalog, overrides)` — looks up catalog, builds model, applies overrides, throws with suggestions on miss, falls through to `null` when catalog is unavailable (caller handles fallback)

### `src/agent/models.ts` — Refactored Poe resolution

- **Keep:** `MODELS` record — all non-Poe entries unchanged. All `poe/*` entries moved out.
- **Keep:** `poePatternMatch()`, `poeAnthropic()`, `poeResponses()`, `poeCompletions()` — preserved as catalog-unavailable fallback
- **Keep:** `ApiKeyEnv`, `ModelEntry`, `resolveModel()`, pattern matchers for non-Poe providers, `resolveMaxTokens()`, `getApiKey()`, `ZERO_COST`, `POE_ANTHROPIC`, `POE_OPENAI`
- **Add:** `POE_OVERRIDES: Record<string, Partial<Pick<Model<Api>, "contextWindow" | "maxTokens">>>` — Poe-specific overrides (e.g. `poe/gemini-2.5-pro` context window)
- **Modify:** `resolveModel()` — for `poe/*` names, try `resolvePoeModel()` via catalog; if that returns `null` (catalog unavailable), fall through to `poePatternMatch()`
- **Remove:** All `poe/*` entries from `MODELS` record (moved to `POE_OVERRIDES`)

### `src/agent/poe-validate.ts` — Deleted

- Functionality subsumed by `poe-catalog.ts`. The catalog fetch validates model existence as a side effect. Close-match suggestion logic lives in `resolvePoeModel()`.

### `src/agent/mod.ts` — Minor changes

- **Remove:** `ModelNotCapableError` class
- **Remove:** Image capability check in `prompt()` (the `hasImage && !model.input.includes("image")` block)
- **Modify:** `init()` — call `initPoeCatalog()` before `resolveModel()` (for the catalog to be populated)
- **Keep:** Everything else unchanged

### `src/bot.ts` — Minor changes

- **Remove:** `ModelNotCapableError` import
- **Remove:** The `instanceof ModelNotCapableError` catch block in the photo handler
- **Keep:** Generic error handling in the photo handler catch block (not removed — non-capability errors still need surfacing)

### `src/index.ts` — Startup wiring

- **Modify:** Replace `validateModelAtStartup()` call with `initPoeCatalog()` call

## Phase 1: Poe catalog fetch and cache

Introduce `poe-catalog.ts` with the fetch/cache infrastructure. No behavior changes yet — the catalog is fetched but not used by model resolution.

- [ ] Create `src/agent/poe-catalog.ts` with `PoeModelInfo` interface matching the catalog response shape (`id`, `owned_by`, `architecture.input_modalities`, `context_window`, `parameters`, `pricing`)
- [ ] Implement `fetchPoeCatalog(cfg, logger)` — fetches `GET /v1/models`, parses into `Map<string, PoeModelInfo>`, 10s timeout, returns `null` on failure, logs warning on empty data
- [ ] Implement `initPoeCatalog(cfg, logger)` — calls `fetchPoeCatalog`, stores the result in a module-level variable. Logger interface: `{ warn: (msg: string, ctx?: Record<string, unknown>) => void }`
- [ ] Export `getPoeCatalog()` — returns the cached catalog (or `null`)
- [ ] Wire `initPoeCatalog()` call in `src/index.ts` replacing `validateModelAtStartup()`
- [ ] Write tests for `fetchPoeCatalog` (mock fetch: verify parsing, verify timeout, verify null on failure, verify warning on empty data)
- [ ] Verify: `bun run --bun tsc --noEmit && bun test`

## Phase 2: Dynamic Poe model resolution

Add catalog-based resolution alongside the existing pattern matching. The catalog is the primary path; pattern matching becomes the fallback.

- [ ] Implement `buildModelFromCatalog(id, info)` in `src/agent/poe-catalog.ts` — converts a catalog entry to `Model<Api>` using `owned_by` routing (Anthropic → anthropic API, OpenAI → openai-responses, else → openai-completions)
- [ ] Map `architecture.input_modalities` → `Model.input`, filtering to only `"text"` and `"image"` (drop `"audio"`, `"video"`, etc.)
- [ ] Map `context_window.context_length` → `Model.contextWindow` (default `128_000`)
- [ ] Map `maxTokens` via fallback chain: `parameters[].max_output_tokens.maximum` → `context_window.max_output_tokens` → `resolveMaxTokens(id)` → `8_192`
- [ ] Map `pricing` → `Model.cost` (informational only)
- [ ] Set `Model.reasoning`: `true` for Anthropic and OpenAI families, `false` for all others
- [ ] Implement `resolvePoeModel(id, catalog, overrides)` — looks up catalog, calls `buildModelFromCatalog`, applies overrides, throws with suggestions on catalog miss, returns `null` when catalog is unavailable
- [ ] Add startup warning when active model has unrecognized `owned_by` (not `"Anthropic"` or `"OpenAI"`)
- [ ] Add `POE_OVERRIDES` record to `src/agent/models.ts` — type `Record<string, Partial<Pick<Model<Api>, "contextWindow" | "maxTokens">>>`, with `poe/gemini-2.5-pro` context window override
- [ ] Move all `poe/*` entries out of `MODELS` into `POE_OVERRIDES`
- [ ] Modify `resolveModel()` in `src/agent/models.ts` — for `poe/*` names, try `resolvePoeModel()` via catalog; if that returns `null` (catalog unavailable), fall through to existing `poePatternMatch()`
- [ ] Delete `src/agent/poe-validate.ts`
- [ ] Write tests for `buildModelFromCatalog` — full data, null fields, owned_by routing (Anthropic/OpenAI/other), input_modalities filtering, maxTokens fallback chain, reasoning derivation
- [ ] Write tests for `resolvePoeModel` — catalog hit, catalog miss with suggestions, catalog null (returns null), override application
- [ ] Write test for `resolveModel` with catalog — verify poe/* uses catalog, verify fallback to pattern matching when catalog is null
- [ ] Verify: `bun run --bun tsc --noEmit && bun test`

## Phase 3: Remove ModelNotCapableError and clean up bot.ts

Remove the workaround that's no longer needed now that `Model.input` is accurate.

- [ ] Remove `ModelNotCapableError` class from `src/agent/mod.ts`
- [ ] Remove the `hasImage && !model.input.includes("image")` check in `AgentRunner.prompt()`
- [ ] Remove `ModelNotCapableError` import from `src/bot.ts`
- [ ] Simplify the photo handler catch block in `src/bot.ts` — remove `instanceof ModelNotCapableError` branch, keep generic error handling
- [ ] Update `src/agent/mod.test.ts` — update "Poe image-only prompt normalization" tests to verify pi's `downgradeUnsupportedImages()` path instead of `ModelNotCapableError` throw
- [ ] Verify: `bun run --bun tsc --noEmit && bun test`

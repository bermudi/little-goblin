# config-system Tasks

## Phase 1: Core infrastructure

- [ ] **Add json5 dependency** — `bun add json5`. Verify `import JSON5 from "json5"` compiles.

- [ ] **Create `src/resolve-value.ts`** — Port pi-style value resolver from `pi-mono/packages/coding-agent/src/core/resolve-config-value.ts`. Exports `resolveConfigValue(value: string): string | undefined` and `clearResolveCache()` for testing. Three-way: `!cmd` → `execSync` with 10s timeout (cached), env var match → env value, else literal. Test file: `src/resolve-value.test.ts` covering literal, env var, `!echo`, failed command, and cache behavior.

- [ ] **Create `src/schema.ts`** — Zod schema for JSON5 config shape. Required: `botToken: z.string()`, `allowedUsers: z.array(z.number().int()).min(1)`, `model: z.string()`. Optional: `poeApiKey`, `openrouterApiKey`, `openaiApiKey`, `anthropicApiKey` (all `z.string().optional()`). `logLevel: z.enum(["debug","info","warn","error"]).default("info")`. `goblinHome` not in schema (default depends on `homedir()`). Exports `ConfigFileSchema` and `type ConfigFile`.

## Phase 2: Rewrite config and log

- [ ] **Rewrite `src/config.ts`** — New `loadConfig()`: resolve `goblinHome` from env/default → read `goblin.json5` → `JSON5.parse()` → resolve all string values via `resolveConfigValue()` → `ConfigFileSchema.parse()` → build `Config` object (same interface shape, add `logLevel`). `allowedUsers` array → `Set<number>`, `model` → `modelName`. Freeze result. `ensureGoblinHome()` unchanged. Test: `src/config.test.ts` covering valid file, missing file, missing field, shell/env resolution, Zod rejection, defaults.

- [ ] **Modify `src/log.ts`** — Remove `process.env.LOG_LEVEL` read. Default threshold to `info`. Export `initLog(level: Level): void` to set threshold post-config. `log` object unchanged.

- [ ] **Update `src/index.ts`** — Import `initLog`, call `initLog(cfg.logLevel)` after `loadConfig()`.

## Phase 3: Examples and cleanup

- [ ] **Create `goblin.json5.example`** — Annotated example config at repo root. Show all fields, demonstrate `!` command and env var name patterns in comments.

- [ ] **Slim down `.env.example`** — Note that config lives in `goblin.json5`. Keep only env vars useful for dev (API keys, BOT_TOKEN). Remove MODEL_NAME, LOG_LEVEL, ALLOWED_TG_USER_IDS, GOBLIN_HOME.

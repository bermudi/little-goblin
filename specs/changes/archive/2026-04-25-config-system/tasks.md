# config-system Tasks

## Phase 1: Core infrastructure

- [x] **Add json5 dependency** — `bun add json5`. Verify `import JSON5 from "json5"` compiles.

- [x] **Create `src/resolve-value.ts`** — Port pi-style value resolver from `pi-mono/packages/coding-agent/src/core/resolve-config-value.ts`. Exports `resolveConfigValue(value: string): string | undefined` and `clearResolveCache()` for testing. Three-way: `!cmd` → `execSync` with 10s timeout (cached), env var match → env value, else literal. Test file: `src/resolve-value.test.ts` covering literal, env var, `!echo`, failed command, and cache behavior.

- [x] **Create `src/schema.ts`** — Zod schema for JSON5 config shape. Required: `botToken: z.string()`, `allowedUsers: z.array(z.number().int().positive()).min(1)`, `model: z.string()`. Optional: `poeApiKey`, `openrouterApiKey`, `openaiApiKey`, `anthropicApiKey` (all `z.string().optional()`). `logLevel: z.enum(["debug","info","warn","error"]).default("info")`. `goblinHome` not in schema (default depends on `homedir()`). Exports `ConfigFileSchema` and `type ConfigFile`.

## Phase 2: Rewrite config and log

- [x] **Rewrite `src/config.ts`** — New `loadConfig()`: resolve `goblinHome` from env/default → read `goblin.json5` → `JSON5.parse()` → resolve all string values via `resolveConfigValue()` → `ConfigFileSchema.parse()` → build `Config` object (same interface shape, add `logLevel`). `allowedUsers` array → `Set<number>`, `model` → `modelName`. Freeze result. `ensureGoblinHome()` unchanged. Test: `src/config.test.ts` covering valid file, missing file, missing field, shell/env resolution, Zod rejection, defaults.

- [x] **Modify `src/log.ts`** — Remove `process.env.LOG_LEVEL` read. Default threshold to `info`. Export `initLog(level: Level): void` to set threshold post-config. `log` object unchanged.

- [x] **Update `src/index.ts`** — Import `initLog`, call `initLog(cfg.logLevel)` after `loadConfig()`.

## Phase 3: Examples and cleanup

- [x] **Create `goblin.json5.example`** — Annotated example config at repo root. Show all fields, demonstrate `!` command and env var name patterns in comments.

- [x] **Slim down `.env.example`** — Note that config lives in `goblin.json5`. Keep only env vars useful for dev (API keys, BOT_TOKEN). Remove MODEL_NAME, LOG_LEVEL, ALLOWED_TG_USER_IDS, GOBLIN_HOME.

## Phase 4: Onboard command (openclaw-style)

- [x] **Create `src/onboard.ts`** — Interactive config generator. Exports `main()` for testing. Reads existing `.env` for defaults. Prompts for: bot token, user ID, model, log level, API keys (all optional). Validates with Zod before writing. Shows preview. Idempotent: refuses to overwrite existing config.

- [x] **Add `onboard` script** — `package.json` scripts: `"onboard": "bun run src/onboard.ts"`.

- [x] **Test `src/onboard.test.ts`** — Test helper functions (parseIdList, buildConfig). Test that main() exits when config exists.

# config-system

## Motivation

Configuration currently lives in `.env` files read via `process.env`. This conflates two concerns: application settings (model name, log level, allowed users) and secrets (API keys, bot token). When secrets come from external sources — e.g. `export POE_API_KEY=$(pass-cli ...)` — the `.env` file becomes either incomplete or a stale duplicate of the real source. There's no single source of truth.

Additionally, `log.ts` reads `LOG_LEVEL` directly from `process.env` independently of `loadConfig()`, meaning config has two entry points.

## Scope

Replace `.env`-only configuration with a JSON5 config file + pi-style value resolution.

### Config file

- `goblin.json5` at `$GOBLIN_HOME/goblin.json5` (default: `~/goblin/goblin.json5`).
- Contains all settings: model, log level, allowed users, API keys, bot token, goblin home.
- JSON5 format (comments, trailing commas, unquoted keys).

### Value resolution (pi pattern)

Any string value in the config supports three forms, resolved at startup:

1. **`!command`** — shell command, executed once, output cached for process lifetime.
2. **Env var name** — if the string matches an existing `process.env` key, use the env value.
3. **Literal** — otherwise, use the string as-is.

This is the exact pattern from `pi-mono/packages/coding-agent/src/core/resolve-config-value.ts`. No `${...}` syntax needed.

### Zod validation

The merged config (after resolution) is validated with a Zod schema. Fail-closed: invalid config kills the process with a clear error.

### Log level unification

`log.ts` stops reading `process.env.LOG_LEVEL` directly. Log level comes from the config object like everything else.

### .env becomes optional

`.env` files still work (Bun auto-loads them into `process.env`), but they're a convenience for populating env vars — not the config source of truth. The config file is.

## Non-Goals

- Runtime config reloading (restart to pick up changes)
- Config writes from the application (read-only)
- `$include` / config splitting (one file is enough)
- Config file migration tooling (manual one-time switch)
- Web UI or interactive config editor
- Encrypted config file (secrets stay in vault/env, not on disk — or if on disk, that's the user's choice)

# config-system Design

## Architecture

```
                        startup
                          │
        ┌─────────────────▼──────────────────┐
        │  resolveGoblinHome()               │
        │  (env GOBLIN_HOME → ~/goblin)      │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │  read $GOBLIN_HOME/goblin.json5    │
        │  parse with json5                  │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │  resolveConfigValue() each string  │
        │  !cmd → exec+cache                 │
        │  env match → env value             │
        │  else → literal                    │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │  Zod schema validation             │
        │  (parse, apply defaults, type)     │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │  Config object (frozen)            │
        │  passed to bot, agent, log, etc.   │
        └────────────────────────────────────┘
```

The config file is the single source of truth. `.env` files still work — Bun loads them into `process.env` before our code runs — but they're just one way to populate env vars that the config file can reference.

`GOBLIN_HOME` is the one value that must come from env (or default) because it determines *where* the config file lives. Everything else lives in the config file.

## Decisions

### JSON5 over TOML/YAML

JSON5 is minimal (one npm dep: `json5`), familiar, supports comments/trailing commas. TOML would work but adds a heavier parser and the config is flat enough that TOML's sections don't add value. YAML is a footgun.

### Pi-style resolution over ${VAR} syntax

Adopting pi's exact pattern: no special syntax for env vars. A string is checked against `process.env` first; if it matches a key, the env value is used. Otherwise it's a literal. `!` prefix for shell commands.

This is simpler and proven. The only edge case (literal string that happens to match an env var name) is practically impossible for API keys and tokens.

### Zod schema as the single type source

The `Config` interface is derived from the Zod schema via `z.infer<>`. No separate interface definition. Defaults live in the schema (`.default()`). This guarantees the type and runtime validation are always in sync.

### Log level moves into Config

`log.ts` currently reads `process.env.LOG_LEVEL` at import time. After this change, `log.ts` exports an `initLog(level)` function called after config loads. The `log` object itself remains the same — only initialization changes.

### Config file location: GOBLIN_HOME, not XDG

The config file lives at `$GOBLIN_HOME/goblin.json5`, not `~/.config/goblin/`. This keeps everything colocated — sessions, skills, and config in one directory. `GOBLIN_HOME` can still be set to an XDG-style path if the user wants.

## File Changes

### New: `src/resolve-value.ts`

Pi-style value resolver. Three-way resolution: `!cmd` → shell exec (cached), env var match → env value, else literal. Ported from `pi-mono/packages/coding-agent/src/core/resolve-config-value.ts`, simplified (no Windows-specific shell config, no uncached variant needed).

Exports: `resolveConfigValue(value: string): string | undefined`

### New: `src/schema.ts`

Zod schema for the raw config file shape (pre-resolution). All string fields that support resolution are `z.string()`. Array fields like `allowedUsers` are `z.array(z.number().int())`. Defaults defined here.

Exports: `ConfigFileSchema`, `type ConfigFile`

### Modified: `src/config.ts`

Complete rewrite. New flow:

1. Determine `goblinHome` (env `GOBLIN_HOME` or `~/goblin`)
2. Read `$GOBLIN_HOME/goblin.json5` via `json5.parse()`
3. Resolve all string values using `resolveConfigValue()`
4. Validate with Zod schema
5. Build `Config` object (convert `allowedUsers` array → `Set<number>`)
6. Return frozen `Config`

The `Config` interface shape stays the same to minimize caller changes — `allowedTgUserIds` remains a `Set<number>`, field names stay the same. Only the source changes from env vars to config file.

`ensureGoblinHome()` stays here, unchanged.

### Modified: `src/log.ts`

- Remove direct `process.env.LOG_LEVEL` read at module level
- Export `initLog(level: Level)` to set threshold after config loads
- Default threshold stays `info` until `initLog()` is called (safety for import-order edge cases)

### Modified: `src/index.ts`

- Call `loadConfig()` (now reads JSON5)
- Call `initLog(cfg.logLevel)` before starting bot
- Rest unchanged

### New: `goblin.json5.example`

Example config file (replaces `.env.example` as primary documentation):

```json5
{
  // Telegram bot token (from BotFather)
  botToken: "BOT_TOKEN",

  // Telegram user IDs allowed to interact
  allowedUsers: [123456789],

  // Model ID — see src/agent/models.ts for options
  model: "poe/Claude-Sonnet-4.6",

  // API keys — use env var names, literals, or !shell commands
  // poeApiKey: "POE_API_KEY",
  // poeApiKey: "!pass-cli item view 'pass://Keys/Poe/Api Key'",
  // openrouterApiKey: "OPENROUTER_API_KEY",
  // openaiApiKey: "OPENAI_API_KEY",
  // anthropicApiKey: "ANTHROPIC_API_KEY",

  // logLevel: "info",  // debug | info | warn | error
}
```

### Kept: `.env.example`

Kept but slimmed down — documents that `.env` populates env vars, points to `goblin.json5` as the real config. Not deleted because `.env` remains a valid way to set env vars.

### New dep: `json5`

Added via `bun add json5`. Lightweight JSON5 parser.

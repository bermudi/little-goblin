# Adopt Existing Scaffold

## Motivation

The little-goblin codebase has a working scaffold that handles Telegram bot initialization, configuration loading, session management, and command handling. Before proceeding with agent integration, we need to document the existing behavior as a baseline. This ensures future changes have a clear reference point and prevents accidental regressions in critical infrastructure like the allowlist security layer and atomic file persistence.

## Scope

This change reverse-engineers specifications from the existing implementation:

- **Configuration loading** (`src/config.ts`): Environment variable parsing, validation, GOBLIN_HOME setup
- **Logging** (`src/log.ts`): Structured logging with level filtering
- **Telegram layer** (`src/tg/`): Allowlist middleware, chat locator derivation
- **Session management** (`src/sessions/`): Session lifecycle, persistence, bindings
- **Command handlers** (`src/commands/`): /ping and /new command implementations
- **Model registry** (`src/agent/models.ts`): Provider/model mapping and API key resolution
- **Bot orchestration** (`src/bot.ts`, `src/index.ts`): Startup, graceful shutdown, middleware wiring

## Non-Goals

- Do NOT modify any source files
- Do NOT add new functionality
- Do NOT spec `src/agent/mod.ts` (empty stub with no behavior)
- Do NOT include design documents (`progress.md`, `pi-and-openclaw.md`) — spec only what code actually does

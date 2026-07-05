# Config Startup Filesystem Mutation

## Status

accepted

## Context

The AGENTS.md guardrail states: "Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, and `paths.ts`." This guardrail keeps `$GOBLIN_HOME` mutation centralized and auditable.

However, `src/config.ts` performs direct filesystem mutation in `ensureGoblinHome()` — it creates the `$GOBLIN_HOME` directory tree on startup. This is a pre-existing tension: `config.ts` must create directories before any `SessionManager`, `MemoryStore`, or `paths.ts` consumer can operate, so it cannot delegate upward to those modules without a circular dependency. The guardrail exception needs to be explicit rather than implicit.

The `workspace-layout` change originally added a one-time migration loop (`renameSync` for legacy root-level paths → new `workspace/`/`state/`/`scratch/` paths). That migration has been completed and the migration code has been removed. The exemption now covers directory creation only.

## Decision

`src/config.ts` is exempted from the AGENTS.md "Don't touch `$GOBLIN_HOME`" guardrail, but ONLY for the `ensureGoblinHome()` startup path: directory creation (`mkdirSync`). This exemption SHALL be documented in AGENTS.md alongside the guardrail.

The exemption is narrow: `config.ts` MUST NOT read or write session bindings, memory, or any other runtime state. Its filesystem access is limited to directory creation (`mkdirSync`). All path construction inside `ensureGoblinHome()` MUST go through the path-helper modules (`sessions/paths.ts`, `pi-host.ts`, `memory/paths.ts`, `subagents/paths.ts`) — see decision `path-helper-only-path-construction`.

## Consequences

- Easier: `ensureGoblinHome()` can run before any consumer module is initialized, avoiding circular dependencies.
- Harder: the AGENTS.md guardrail now has an explicit exception, which must be maintained as `config.ts` evolves. Any new direct filesystem mutation in `config.ts` outside `ensureGoblinHome()` would violate this decision.
- Must change: AGENTS.md guardrail section must list `config.ts` (for `ensureGoblinHome` startup directory creation) alongside `SessionManager`, `MemoryStore`, and `paths.ts`.

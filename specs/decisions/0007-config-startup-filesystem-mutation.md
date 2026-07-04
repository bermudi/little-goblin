# Config Startup Filesystem Mutation

## Status

accepted

## Context

The AGENTS.md guardrail states: "Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, and `paths.ts`." This guardrail keeps `$GOBLIN_HOME` mutation centralized and auditable.

However, `src/config.ts` already performs direct filesystem mutation in `ensureGoblinHome()` — it creates the `$GOBLIN_HOME` directory tree on startup and (pre-existing) runs the `pi-agent/` → `goblin/` rename migration. The `workspace-layout` change expands `config.ts`'s direct filesystem mutation surface by adding a multi-item migration loop (`renameSync` for every legacy root-level path → new `workspace/`/`state/`/`scratch/` path).

This is a pre-existing tension: `config.ts` must create directories and run migrations before any `SessionManager`, `MemoryStore`, or `paths.ts` consumer can operate, so it cannot delegate upward to those modules without a circular dependency. The guardrail exception needs to be explicit rather than implicit.

## Decision

`src/config.ts` is exempted from the AGENTS.md "Don't touch `$GOBLIN_HOME`" guardrail, but ONLY for the `ensureGoblinHome()` startup path: directory creation and one-time migration `renameSync` calls. This exemption SHALL be documented in AGENTS.md alongside the guardrail.

The exemption is narrow: `config.ts` MUST NOT read or write session bindings, memory, or any other runtime state. Its filesystem access is limited to directory creation (`mkdirSync`) and migration (`renameSync` of legacy paths to new paths). All path construction inside `ensureGoblinHome()` MUST go through the path-helper modules (`sessions/paths.ts`, `pi-host.ts`, `memory/paths.ts`, `subagents/paths.ts`) — see decision `path-helper-only-path-construction`.

## Consequences

- Easier: `ensureGoblinHome()` can run before any consumer module is initialized, avoiding circular dependencies.
- Easier: the migration loop can use `renameSync` directly without routing through `SessionManager`/`MemoryStore` (which would couple startup layout to runtime state managers).
- Harder: the AGENTS.md guardrail now has an explicit exception, which must be maintained as `config.ts` evolves. Any new direct filesystem mutation in `config.ts` outside `ensureGoblinHome()` would violate this decision.
- Must change: AGENTS.md guardrail section must list `config.ts` (for `ensureGoblinHome` startup mutation) alongside `SessionManager`, `MemoryStore`, and `paths.ts`.

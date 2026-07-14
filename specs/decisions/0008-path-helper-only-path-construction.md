# Path Helper Only Path Construction

## Status

accepted

## Context

The codebase centralizes `$GOBLIN_HOME` path construction in five path-helper modules: `src/sessions/paths.ts`, `src/pi-host.ts`, `src/workspace/paths.ts`, `src/memory/paths.ts`, and `src/subagents/paths.ts`. Each is a flat set of pure functions taking `home: string`. All callers import the helpers rather than constructing paths inline with `join(home, ...)`.

Two inline `join(home, "skills")` constructions currently exist in `src/agent/mod.ts` and `src/subagents/named-agents.ts` for the `workspace/skills/` path, which is not exported by any path-helper module. The `workspace-layout` change adds a `skillsPath(home)` helper to `src/workspace/paths.ts` to close this gap.

The `workspace-layout` migration loop in `ensureGoblinHome()` (`src/config.ts`) needs to construct both old (legacy) and new paths. If it constructs these inline with `join(home, ...)`, the path-helper modules would no longer be the single source of path truth — `config.ts` would silently duplicate the path logic, and future path changes could drift between the helpers and the migration code.

## Decision

All `$GOBLIN_HOME` path construction in the codebase SHALL go through the path-helper modules (`sessions/paths.ts`, `pi-host.ts`, `workspace/paths.ts`, `memory/paths.ts`, `subagents/paths.ts`). Inline `join(home, ...)` path construction is prohibited outside these modules.

The migration loop in `ensureGoblinHome()` SHALL construct all paths (both legacy source paths and new target paths) via the path-helper modules. If a legacy path is not currently exported by a helper (e.g. the old `sessions/` root), the helper module SHALL be extended to export it (or a dedicated `legacy*Path` helper) rather than allowing inline construction in `config.ts`.

This is a standing structural ruling, not a one-time design detail of `workspace-layout`. It applies to all future code that constructs `$GOBLIN_HOME` paths.

## Consequences

- Easier: path truth is centralized — changing a path means updating one helper, not hunting for inline `join(home, ...)` calls across the codebase.
- Easier: the migration loop cannot silently drift from the helpers.
- Harder: adding a new `$GOBLIN_HOME` path requires extending a helper module rather than writing an inline `join`. This is a small cost for the centralization benefit.
- Must change: the two existing inline `join(home, "skills")` constructions in `src/agent/mod.ts` and `src/subagents/named-agents.ts` are replaced with `skillsPath(home)` (added to `src/workspace/paths.ts`) as part of `workspace-layout`.

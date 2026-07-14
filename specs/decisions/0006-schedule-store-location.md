# Schedule Store Location

## Status

superseded by `workspace-layout` (2026-07-05) — the schedule store relocated from `<home>/schedules.json` to `<home>/state/schedules.json` as part of the root-level → `state/` migration. The structural ruling below still holds (single JSON file, NOT under an individual session directory, path resolved via `schedulesPath(home)`); only the resolved path changed. See decision `path-helper-only-path-construction` (0008) and the `workspace-layout` change for the current path.

## Context

Goblin's scheduled-turns feature needs to persist schedule definitions (one-shot, recurring, and heartbeat schedules) somewhere under `$GOBLIN_HOME`. The AGENTS.md guardrail restricts code-tree access to `$GOBLIN_HOME` to `SessionManager`, `MemoryStore`, and `paths.ts`. Schedules must be discoverable at startup before any individual session is loaded, and schedule lifecycle must survive session archive operations.

## Decision

The schedule store SHALL live in a single JSON file at `<home>/schedules.json`, with the path resolved via `schedulesPath(home)` in `src/sessions/paths.ts`. The schedule store MUST NOT live inside an individual session directory (`sessions/<id>/`), because schedules need to be discoverable at startup before any runner is created, and per-session placement would make startup discovery require scanning every session and would make schedule lifecycle awkward when sessions are archived.

## Consequences

- Easier: startup discovers all schedules by reading one file; no session-directory scan needed.
- Easier: schedule lifecycle is independent of session archive/move operations.
- Harder: the schedule store is single-process only — no cross-process locking is added. If multiple Goblin processes ever share a home directory, they would race on `schedules.json`.
- Must change: `src/sessions/paths.ts` gains a `schedulesPath(home)` helper; `ScheduleStore` consumes it rather than constructing the path directly.

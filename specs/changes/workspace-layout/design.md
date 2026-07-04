# workspace-layout — Design

## Architecture

This change is a pure filesystem relocation. No behavior changes, no new features, no data format changes. Every path helper in the codebase returns a new location; every caller imports the helper and is unaffected.

The existing `ensureGoblinHome()` in `src/config.ts` already has a migration precedent: it renames `pi-agent/` → `goblin/` on startup. This change extends that same pattern to all root-level paths.

### Path helper inventory

The codebase centralizes paths in four modules. Each is a flat set of pure functions taking `home: string`:

| Module | Functions | Current root | New root |
|---|---|---|---|
| `src/sessions/paths.ts` | `sessionsDir`, `sessionDir`, `statePath`, `transcriptPath`, `configPath`, `topicSettingsPath`, `schedulesPath` | `$GOBLIN_HOME/` | `$GOBLIN_HOME/state/` |
| `src/pi-host.ts` | `workdirPath`, `piAgentDir`, `agentsMdPath`, `soulMdPath` | `$GOBLIN_HOME/` | `$GOBLIN_HOME/scratch/` + `$GOBLIN_HOME/state/pi/` + `$GOBLIN_HOME/workspace/` |
| `src/memory/paths.ts` | `memoryDir`, `scopeMemoryPath`, `userPath`, `archiveTopicPath` | `$GOBLIN_HOME/memory/` | `$GOBLIN_HOME/state/memory/` |
| `src/subagents/paths.ts` | `subagentsRoot`, `genericSubagentDir`, `namedAgentsRoot`, `namedAgentDir`, `namedAgentInstanceDir`, etc. | `$GOBLIN_HOME/subagents/` + `$GOBLIN_HOME/agents/` | `$GOBLIN_HOME/scratch/subagents/` + `$GOBLIN_HOME/workspace/agents/` |

No other module constructs the paths owned by these four modules inline — all callers import the path helpers. Two inline `join(home, "skills")` constructions exist in `src/agent/mod.ts:206` and `src/subagents/named-agents.ts:93` for the `workspace/skills/` path, which is not exported by any of the four path-helper modules. These should be replaced with a `skillsPath(home)` helper added to `src/pi-host.ts` (alongside `agentsMdPath`/`soulMdPath`) so all workspace path construction is centralized.

### Migration ordering

Migration runs inside `ensureGoblinHome()` in three phases. The critical invariant is: migration-target subdirectories MUST NOT be pre-created before migration, or the "new path does not exist" guard would skip every directory migration on legacy installs (the empty target dir would already exist).

1. **Pre-migration:** create only the three top-level group directories (`workspace/`, `state/`, `scratch/`). Do NOT create migration-target subdirectories (`workspace/skills/`, `workspace/agents/`, `state/sessions/`, `state/memory/`, `state/pi/`, `scratch/workdir/`, `scratch/subagents/`).
2. **Migration:** for each migration pair, if old exists and new doesn't, `renameSync(old, new)`. If both exist, log warning and skip (operator resolves).
3. **Post-migration:** `mkdirSync` all migration-target subdirectories that still don't exist (fresh install or legacy install where the legacy path was absent).

The `memory/` migration includes the `.git/` directory inside it — `renameSync` is recursive, so the git repo moves intact. No `git` commands run during migration.

## Decisions

### Migration is renameSync, not copy

Chosen: `renameSync(old, new)` for each item.

Why: atomic on the same filesystem, no data duplication, no cleanup step. The existing `pi-agent/` → `goblin/` migration in `ensureGoblinHome()` already uses this pattern.

Constraints: if `$GOBLIN_HOME` is on a filesystem where `renameSync` across directories fails (e.g. cross-device), migration will throw. This is acceptable per AGENTS.md "fail loud" — the operator resolves it manually.

### No dual-read fallback

Chosen: after migration, code reads only from new paths. No "if new doesn't exist, try old" fallback.

Why: the AGENTS.md guardrail says "No silent compat for old/malformed config keys." A dual-read fallback would violate this and leave stale old paths on disk. Migration runs once at startup; if it succeeds, old paths are gone.

Constraints: if migration fails partway, startup will fail on the first path helper that can't find its file. The operator resolves by re-running or manually moving the remaining items.

### bindings.json, not config.json

Chosen: rename `config.json` to `state/bindings.json`.

Why: the name `config.json` collides conceptually with `goblin.json5` (the actual user config). `bindings.json` describes what the file contains (session bindings). The `BindingsFile` type and `loadBindings`/`saveBindings` function names already use this name internally — the filename just catches up.

### goblin/ → state/pi/, not state/goblin/

Chosen: rename `goblin/` (pi auth + model registry) to `state/pi/`.

Why: the directory holds pi's `auth.json` and `models.json` — pi-owned state, not goblin-owned. Naming it `pi/` makes the ownership clear. The `piAgentDir()` function name stays as-is (it's an internal API name); only the path it returns changes.

### Named agent definitions in workspace/, instances in scratch/

Chosen: `workspace/agents/<name>/` holds definitions (`AGENTS.md`, `skills/`); `scratch/subagents/<id>/` holds generic subagent instance dirs; `workspace/agents/<name>/instances/<id>/` holds named agent instance dirs.

Why: definitions are user-authored prompt files (siblings of `workspace/SOUL.md` and `workspace/AGENTS.md`). Instance dirs are ephemeral runtime state. The split matches the workspace/state/scratch separation.

Constraints: named agent instance dirs live under `workspace/agents/<name>/instances/` rather than `scratch/` because they're scoped to the named agent's definition tree. This preserves the existing `namedAgentInstanceDir()` path structure — only the root changes from `agents/` to `workspace/agents/`.

### No CLAUDE.md symlink

Chosen: do not add `CLAUDE.md → AGENTS.md` symlinks (openclaw pattern).

Why: goblin uses pi, not Claude. The symlink is a compat shim for Claude-specific tools. Adding it would be cargo-culting. If goblin ever needs Claude compat, it can be added later.

## File Changes

### `src/config.ts`

- `ensureGoblinHome()`: replace the current directory list with the three-phase approach: (1) create top-level groups (`workspace/`, `state/`, `scratch/`); (2) run migration loop; (3) create remaining subdirectories (`workspace/skills/`, `workspace/agents/`, `state/sessions/`, `state/memory/`, `state/pi/`, `scratch/workdir/`, `scratch/subagents/`). Remove the `pi-agent/` → `goblin/` migration (superseded). Add the full migration loop for all legacy paths.
- The migration loop uses `renameSync` on legacy paths directly. The AGENTS.md guardrail says "Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, and `paths.ts`." `config.ts` already creates dirs in `ensureGoblinHome()` today (pre-existing tension), but this change expands its direct filesystem mutation surface. The migration loop SHALL construct all paths via the path-helper modules (`sessions/paths.ts`, `pi-host.ts`, `memory/paths.ts`, `subagents/paths.ts`) rather than inline `join(home, ...)` calls, so `paths.ts` modules remain the single source of path truth. The guardrail exception for `config.ts` startup mutation (`ensureGoblinHome`) SHALL be documented in AGENTS.md.
- Relates to: `Ensure GOBLIN_HOME directory structure`, `One-time migration of legacy root-level paths`.

### `src/sessions/paths.ts`

- `sessionsDir()`: `join(home, "sessions")` → `join(home, "state", "sessions")`
- `configPath()`: `join(home, "config.json")` → `join(home, "state", "bindings.json")`
- `topicSettingsPath()`: `join(home, "topic-settings.json")` → `join(home, "state", "topic-settings.json")`
- `schedulesPath()`: `join(home, "schedules.json")` → `join(home, "state", "schedules.json")`
- Relates to: `Persist bindings atomically`, `Create session filesystem layout`, `Topic settings file`, `Topic settings atomic write`.

### `src/sessions/bindings.ts`

- `pathFor()`: already calls `configPath(home)` from `paths.ts`, so no change needed if `configPath` is updated. Verify the temp file name changes from `.config.<rand>.tmp` to `.bindings.<rand>.tmp`.
- Relates to: `Persist bindings atomically`.

### `src/sessions/topic-settings.ts`

- Path helper already calls `topicSettingsPath(home)` from `paths.ts`. No change needed if `topicSettingsPath` is updated. Verify temp file naming.
- Relates to: `Topic settings atomic write`.

### `src/pi-host.ts`

- `workdirPath()`: `join(home, "workdir")` → `join(home, "scratch", "workdir")`
- `piAgentDir()`: `join(home, "goblin")` → `join(home, "state", "pi")`
- `agentsMdPath()`: `join(home, "AGENTS.md")` → `join(home, "workspace", "AGENTS.md")`
- `soulMdPath()`: `join(home, "SOUL.md")` → `join(home, "workspace", "SOUL.md")`
- Add `skillsPath(home)`: `join(home, "workspace", "skills")` — new helper to centralize the `workspace/skills/` path currently constructed inline in `src/agent/mod.ts` and `src/subagents/named-agents.ts`.
- Relates to: `Pi-host module exports pi filesystem path helpers`, `Pi-host exposes Goblin prompt file paths`, `Pi-host module provides shared pi service construction`.

### `src/agent/system-prompt.ts`

- No code changes — it imports `agentsMdPath` and `soulMdPath` from `pi-host.ts`. Path changes propagate through imports.
- Error messages reference `$GOBLIN_HOME/SOUL.md` — update string literals to `$GOBLIN_HOME/workspace/SOUL.md`.
- Relates to: `Prompt file reads fail loud except optional missing files`, `Prompt validation uses a shared error contract`, `Startup preflights Goblin prompt files` (orchestration).

### `src/agent/mod.ts`

- `additionalSkillPaths: [join(home, "skills")]` → `additionalSkillPaths: [skillsPath(home)]` (line 206), importing `skillsPath` from `pi-host.ts`.
- `piAgentDir(home)` call already goes through `pi-host.ts` — propagates automatically.
- `workdirPath(home)` call already goes through `pi-host.ts` — propagates automatically.
- Relates to: `cwd is the shared goblin workspace`, `Shared services point at $GOBLIN_HOME/goblin/`, `Main agent skill discovery is configurable`.

### `src/memory/paths.ts`

- `memoryDir()`: `join(home, "memory")` → `join(home, "state", "memory")`
- All other functions (`scopeMemoryPath`, `userPath`, `archiveTopicPath`) derive from `memoryDir()` — propagate automatically.
- Relates to: `Memory store filesystem layout`, `Atomic writes`, `Git-backed versioning`, `Memory scopes by chat surface and named agent`, `Orphan topic scopes move to archive on failed resolve`.

### `src/subagents/paths.ts`

- `subagentsRoot()`: `join(home, "subagents")` → `join(home, "scratch", "subagents")`
- `namedAgentsRoot()`: `join(home, "agents")` → `join(home, "workspace", "agents")`
- All other functions derive from these two — propagate automatically.
- Relates to: `Named subagents load isolated definitions`, `Subagent sessions persist to disk`, `Generic subagents inherit parent skills`.

### `src/subagents/named-agents.ts`

- `additionalSkillPaths: [join(home, "skills")]` → `additionalSkillPaths: [skillsPath(home)]` (line 93), importing `skillsPath` from `pi-host.ts`.
- Relates to: `Generic subagents inherit parent skills`.

### `src/subagents/runner.ts`

- All path references go through `paths.ts` helpers — propagate automatically.
- Verify no inline `join(home, ...)` path construction remains.

### `src/onboard.ts`

- If onboarding creates `SOUL.md` or `AGENTS.md`, update the write paths to `workspace/SOUL.md` and `workspace/AGENTS.md`.
- Relates to: `Onboarding creates deployment prompt files` (orchestration), `Prompt file reads fail loud except optional missing files`.

### Test files

Every test that constructs paths via `join(tmpDir, "sessions")`, `join(tmpDir, "memory")`, etc. needs updating to the new paths. Tests that use the path helper functions (`sessionsDir(home)`, `memoryDir(home)`, etc.) propagate automatically. The following test files have inline path construction that needs manual updates:

- `src/agent/mod.test.ts` — `join(home, "memory")`, `join(home, "sessions", ...)`, `join(home, "skills")`
- `src/subagents/test/support.ts` — `join(home, "workdir")`, `join(home, "goblin")`
- `src/subagents/test/memory.suite.ts` — `join(tmp, "memory", "quarantine.jsonl")`
- `src/memory/reflector.test.ts` — `join(home, "sessions", sessionId)`
- `src/commands/voice.test.ts` — `join(home, "sessions", sessionId)`
- `src/config.test.ts` — directory creation assertions
- `src/bot.test.ts` — inline path references to `sessions/`, `memory/`, `workdir/`, `goblin/` root-level dirs
- `src/commands/integration.test.ts` — `cfg.goblinHome, "sessions"` → `cfg.goblinHome, "state", "sessions"`
- `src/commands/dispatch.test.ts` — `harness.cfg.goblinHome, "sessions"` → `harness.cfg.goblinHome, "state", "sessions"`
- `src/tg/intake.test.ts` — inline path references to root-level dirs
- `src/onboard.test.ts` — `join(tempDir, "SOUL.md")`, `join(tempDir, "AGENTS.md")` → `join(tempDir, "workspace", "SOUL.md")`, `join(tempDir, "workspace", "AGENTS.md")`
- `src/agent/system-prompt.test.ts` — `join(tmpDir, "SOUL.md")`, `join(tmpDir, "AGENTS.md")` → `join(tmpDir, "workspace", "SOUL.md")`, `join(tmpDir, "workspace", "AGENTS.md")`

### `AGENTS.md` (repo root)

- Update the Memory section: `$GOBLIN_HOME/memory/` → `$GOBLIN_HOME/state/memory/`
- Update any other path references in the guardrails.
- Extend the guardrail exception list to include `config.ts` for `ensureGoblinHome`-owned startup mutation (directory creation and migration `renameSync`), since the migration loop expands `config.ts`'s direct filesystem mutation surface.

### `specs/glossary.md`

- Update every path-bearing term to the new layout: `binding` (`config.json` → `state/bindings.json`), `SOUL.md` (`$GOBLIN_HOME/SOUL.md` → `$GOBLIN_HOME/workspace/SOUL.md`), `memory.md / user.md` (`$GOBLIN_HOME/memory/` → `$GOBLIN_HOME/state/memory/`), `named subagent` (`~/goblin/agents/<name>/` → `~/goblin/workspace/agents/<name>/`), `persona memory` (`agents/<name>/memory.md` → note the file moves under `state/memory/agents/<name>/memory.md`), `archived session` / `resumable session` / `unbound session` (`sessions/<id>/` → `state/sessions/<id>/`), `workdir` (`sessions/<id>/workdir/` → `state/sessions/<id>/workdir/`).

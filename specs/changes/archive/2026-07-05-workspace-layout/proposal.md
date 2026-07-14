# workspace-layout

## Motivation

`$GOBLIN_HOME` currently mixes three distinct concerns at the same directory level, with no visible boundary between them:

1. **User-authored config and prompt files** — `goblin.json5`, `SOUL.md`, `AGENTS.md`, `skills/`, `agents/<name>/` (named agent definitions). Read at runtime, never machine-mutated.
2. **Machine-managed state** — `config.json` (session bindings), `topic-settings.json`, `sessions/`, `memory/` (agent-curated, git-versioned), `goblin/` (pi auth + model registry). Mutated every turn.
3. **Ephemeral scratch** — `workdir/` (subagent cwd), `subagents/<id>/` (subagent instance dirs). Created and abandoned by tool runs.

The collision is concrete and dangerous: `config.json` (machine-managed session bindings) sits next to `goblin.json5` (the actual user config). A user opening `config.json` looking for their bot token finds session IDs instead, and may either hand-edit bindings (corrupting session state) or assume `goblin.json5` is also machine-managed and avoid editing it. The AGENTS.md rule says "Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, and `paths.ts`" — but the layout itself doesn't communicate that boundary.

The lack of a workspace boundary also obscures the sibling relationship between `SOUL.md` and `AGENTS.md`. Both are prompt files with different loading semantics (required identity vs optional operating rules), but because they sit at the same level as `sessions/` and `goblin.json5`, they read as "more config" rather than "the agent's reading room."

## Scope

This change relocates files and directories within `$GOBLIN_HOME` to make the three-way separation visible on disk. No behavior changes — all path helpers update, all callers remain unaffected, all semantics (atomic writes, git versioning, lazy creation, fail-loud ENOENT) are preserved.

Affected capabilities:

- `config`: `ensureGoblinHome()` creates the new directory tree; migration runs on startup.
- `sessions`: `config.json` (bindings) moves to `state/bindings.json`; `sessions/` moves to `state/sessions/`; `topic-settings.json` moves to `state/topic-settings.json`; `schedules.json` (introduced by `scheduled-turns` dependency) moves to `state/schedules.json`.
- `pi-host`: `goblin/` (pi auth + model registry) moves to `state/pi/`; `workdirPath` moves to `scratch/workdir/`; `soulMdPath` and `agentsMdPath` move to `workspace/`.
- `agent`: `cwd` (workdir) and skill discovery paths update; system-prompt file reads point at `workspace/`.
- `subagents`: named agent definitions move from `agents/` to `workspace/agents/`; subagent instance dirs move from `subagents/` to `scratch/subagents/`.
- `memory`: `memory/` tree moves to `state/memory/`.
- `orchestration`: startup preflight and onboarding prompt file paths move from `$GOBLIN_HOME/SOUL.md` and `$GOBLIN_HOME/AGENTS.md` to `$GOBLIN_HOME/workspace/SOUL.md` and `$GOBLIN_HOME/workspace/AGENTS.md`.

Behavior changes:

- Filesystem layout only. Every path helper returns a new location; every caller imports the helper and is unaffected.

New functionality:

- One-time migration on startup: if an old path exists at `$GOBLIN_HOME` root and the corresponding new path does not, `renameSync` the old path to the new path. Migration is atomic per item and idempotent (skips items already migrated).

Target layout:

```
$GOBLIN_HOME/
  goblin.json5                      # config (stays at root)
  workspace/                        # prompt files (the agent's reading room)
    SOUL.md  AGENTS.md              # siblings, different loading semantics
    skills/                         # goblin's pi skills
    agents/<name>/                  # named agent definitions
      AGENTS.md  skills/
  state/                            # machine-managed
    bindings.json                   # was config.json
    topic-settings.json
    sessions/                       # was sessions/
    memory/                         # was memory/ (git-versioned)
    pi/                             # was goblin/ (auth.json, models.json)
  scratch/                          # ephemeral
    workdir/                        # was workdir/
    subagents/                      # was subagents/ (instance dirs)
```

## Non-Goals

- No new prompt files (`HEARTBEAT.md`, `MEMORY.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`) — that is the `workspace-files` change.
- No change to the agent-curated memory system (scope keys, caps, git versioning, reflection).
- No change to `/project` behavior — `projectDir` remains external to `$GOBLIN_HOME`.
- No change to subagent isolation semantics — named agents still get strict resource-loader isolation.
- No change to the `config.json` format or the `BindingsFile` shape — only the filename and location change.
- No archival of old paths — migration is `renameSync`, not copy. Old paths do not linger.
- No multi-step migration — migration runs once at startup; if it fails partway, the operator resolves it manually (fail loud, per AGENTS.md).

# Design: Project Directory Binding

## Overview

The `/project` command allows a Telegram session to be bound to a filesystem directory. This changes where the agent's file operations (`read`, `edit`, `bash`) execute and which `AGENTS.md` the agent loads as its system prompt.

## Component Changes

### SessionState (src/sessions/types.ts)

Added `projectDir?: string` to the `SessionState` interface. This field is persisted in `sessions/<id>/state.json` and survives restarts.

### SessionManager (src/sessions/manager.ts)

Added `setProjectDir(sessionId, projectDir)` method:
1. Loads existing state via `loadState`
2. Throws if session not found
3. Creates updated state with new `projectDir`
4. Persists atomically via `saveState`

### AgentRunner (src/agent/mod.ts)

Added `projectDir?: string` to `AgentRunnerOptions`. In `init()`:
- `cwd = this.projectDir ?? workdirPath(home)`
- `agentDir = this.projectDir ?? piAgentDir(home)`
- `SessionManager.inMemory(cwd)` — pi's session manager operates in the project directory
- `DefaultResourceLoader` uses `cwd` and `agentDir` — discovers `AGENTS.md` and skills from the project

### Bot Message Handler (src/bot.ts)

Added `/project` to `CANCEL_CAPABLE_COMMANDS` so it gets `interruptAndCascade` before execution.

Handler flow:
1. Call `executeProject()` with injected dependencies
2. `setProjectDir` callback: persist via `manager.setProjectDir()`, then dispose runner with `try/finally` to always delete from map
3. Reply with result + cascade timeout suffix
4. Next message lazily creates new runner with updated `projectDir`

### Command Logic (src/commands/project.ts)

Pure function `executeProject(deps)` returning a discriminated union:
- `no-session` — no active session
- `missing-arg` — no path provided
- `bad-path` — path doesn't exist or isn't a directory
- `set` — successfully bound
- `cleared` — binding removed

Path handling:
- Extracts everything after `/project ` (space-safe)
- Expands `~` and `~/` via `homedir()`
- Resolves to absolute via `resolve()`
- Validates with `existsSync` + `statSync().isDirectory()`

## Data Flow

```
User sends /project ~/foo
  → bot.ts: parseCommand → "/project"
  → interruptAndCascade (abort in-flight stream)
  → executeProject({ hasSession, rawText, setProjectDir })
    → expandTilde → resolve → validate
    → setProjectDir callback
      → manager.setProjectDir(session.id, "/home/daniel/foo")
      → prior.dispose() with try/finally runners.delete()
  → ctx.reply("Project bound to `/home/daniel/foo`")

User sends next message
  → bot.ts: resolve session → state with projectDir
  → runner not in map → create new AgentRunner({ projectDir })
  → runner.init() → pi AgentSession with cwd=/home/daniel/foo, agentDir=/home/daniel/foo
  → agent operates in project directory
```

## Error Handling

| Error | Where | Behavior |
|-------|-------|----------|
| No session | executeProject | Typed result, user reply |
| Missing arg | executeProject | Typed result, user reply |
| Bad path | executeProject | Typed result, user reply |
| setProjectDir throws | bot.ts catch | Log + "Failed to set project directory" reply |
| dispose() throws | bot.ts try/finally | Log + always delete from map |
| Session not found | manager.setProjectDir | Throw, caught by bot.ts catch |
| AGENTS.md malformed | pi init (next message) | Silent failure (pre-existing gap) |

## Testing Strategy

- Command logic: 11 isolated tests mocking `setProjectDir`
- Manager: 3 tests using real filesystem (set, clear, unknown session)
- Integration: covered by existing rapid-command-spam tests

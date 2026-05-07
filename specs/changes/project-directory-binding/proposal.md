# Proposal: Project Directory Binding

## What

A `/project` command that binds a Telegram session to a filesystem directory. Once bound, the session's agent operates in that directory — `read`, `edit`, `bash` all use it as cwd, and the project's `AGENTS.md` becomes the agent's system prompt.

## Why

Goblin sessions currently operate in a sandboxed `$GOBLIN_HOME/workdir` with goblin's generic `AGENTS.md`. Users working on specific projects (e.g., a client engagement) need the agent to understand project context, access project files, and follow project-specific instructions. Without this, every session is generic and blind to the user's actual work.

## Scope

- `/project <path>` — bind current session to an existing directory
- `/project none` or `/project clear` — unbind
- Path validation (exists, is directory)
- Tilde expansion (`~/` and `~`)
- Relative path resolution to absolute
- Space-safe argument parsing
- Cascade-cancel safety (same as `/new`, `/archive`)
- Runner disposal and lazy recreation on change
- Per-session persistence in `state.json`

## Out of Scope

- Named agent registry (e.g. `/agent recam`) — can be added later as a registry layer on top
- Project-specific pi packages (e.g. `npm:pi-playwright` in project's `.pi/settings.json`) — goblin's global pi services are used regardless
- Per-project memory isolation — goblin's memory remains global

## Files Analyzed

- `src/commands/project.ts` — command logic, tilde expansion, path validation
- `src/commands/project.test.ts` — 11 test cases
- `src/sessions/types.ts` — `SessionState.projectDir?: string`
- `src/sessions/manager.ts` — `setProjectDir()` method
- `src/sessions/manager.test.ts` — 3 tests for `setProjectDir`
- `src/agent/mod.ts` — `AgentRunner` uses `projectDir` for cwd/agentDir
- `src/bot.ts` — `/project` wired into message:text handler

## Risks

- **AGENTS.md malformation**: If the project's `AGENTS.md` is malformed, pi initialization fails on the next message. Error is logged but user sees silence. Same pre-existing gap as all agent init failures.
- **Read permission**: Path validation checks existence and directory-ness, but not read permission. EACCES surfaces later as silent init failure.
- **Cascade timeout edge case**: If abort times out, dispose() runs on a potentially wedged session. Mitigated by try/finally always deleting from runner map.

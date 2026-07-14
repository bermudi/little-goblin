# Proposal: Binding-Scoped Project Directory

## Motivation

The `/project` command currently binds a **session** to a filesystem directory. This means `/new` discards the binding because it creates a fresh session. Users expect `/project` to bind the **Telegram topic** (or DM) to a directory — so all sessions in that chat surface operate in the same workspace, just like memory already works topic-scoped.

## Scope

- Introduce `topic-settings.json` — a binding-scoped settings file mapping chat surfaces (topics, DMs) to `projectDir` and other workspace metadata.
- Move `/project` persistence from `SessionState.projectDir` to `topic-settings.json`.
- Update `SessionManager.resolve()` to read `projectDir` from the binding and pass it to `AgentRunner`.
- Deprecate `SessionState.projectDir` — no longer read or written by `/project`.
- Keep `MemoryStore` untouched: memory stays in `$GOBLIN_HOME/memory/` (topic-scoped, not project-scoped).
- Keep `AgentRunner` interface unchanged: it still receives `projectDir` via `AgentRunnerOptions`.

Affected capabilities:
- `sessions` — new `topic-settings.json` module, `resolve()` reads binding settings
- `project-command` — `/project` updates binding settings, not session state
- `agent-runner-project-dir` — `projectDir` source changes (binding, not session), behavior unchanged

## Non-Goals

- No automatic migration of existing `SessionState.projectDir` values. A one-off manual migration script will be provided separately.
- No change to memory filesystem layout. Memory stays in `$GOBLIN_HOME/memory/`.
- No change to `user.md` scope. It stays global.
- No new skills loading behavior. `DefaultResourceLoader` already loads from `cwd`/`agentDir`.

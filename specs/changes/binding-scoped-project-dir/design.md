# Design: Binding-Scoped Project Directory

## Architecture

The change reassigns `projectDir` from the **session** layer to the **binding** layer.

Today:
- `config.json` maps `chatId[/topicId] → sessionId`
- `state.json` holds `projectDir` per session
- `/new` creates a blank session → `projectDir` is lost

After:
- `config.json` maps `chatId[/topicId] → sessionId` (unchanged)
- `topic-settings.json` maps `chatId[/topicId] → { projectDir?, ... }`
- `state.json` drops `projectDir` (deprecated, not read)
- `/new` creates a blank session, but the binding already has `projectDir`

Data flow for a message:

```
Telegram message
  → bot.ts: resolve locator
    → SessionManager.resolve(locator)
      → loads config.json → sessionId
      → loads topic-settings.json → projectDir (if any)
      → loads state.json → SessionState
    → bot.ts: createRunner(session, locator, ctx)
      → manager.getProjectDir(locator) → projectDir
      → new AgentRunner({ projectDir, ... })
        → init(): cwd = projectDir ?? workdirPath(home)
```

Data flow for `/project`:

```
User sends /project ~/foo
  → bot.ts: parseCommand → "/project"
  → executeProject({ setProjectDir: (dir) => manager.setProjectDir(locator, dir) })
    → saveTopicSettings() with updated projectDir for this locator
  → dispose runner for current session
  → reply "Project bound to ..."

User sends next message
  → bot.ts: resolve session (same session, still bound)
  → getOrCreateRunner → reads projectDir from binding
  → AgentRunner init() with new directory
```

## Decisions

### Memory stays in `$GOBLIN_HOME`

Topic memory is not relocated to the project directory. Memory is conversation context (decisions, blockers, notes), not project artifacts. Moving it would require a registry to discover scattered `.goblin/` directories across the filesystem and would break git-versioning simplicity.

### Separate `topic-settings.json` file

Instead of migrating `config.json` from `string → object`, we use a parallel file. This avoids a schema migration on the binding file, keeps routing concerns separate from settings concerns, and makes topic settings inspectable without parsing session IDs.

### `SessionState.projectDir` is deprecated, not removed

Existing `state.json` files may still contain `projectDir`. We stop reading it, but we don't eagerly strip it. A one-off manual migration script (out of scope for this change) will migrate values to `topic-settings.json`. Until then, old sessions with `projectDir` simply fall back to default paths.

### `AgentRunner` interface unchanged

`AgentRunnerOptions.projectDir` stays. Only the *source* changes: from `session.projectDir` to `manager.getProjectDir(locator)`. This minimizes the blast radius.

### Stale bindings leave topic-settings untouched

When `resolve()` encounters a stale DM binding (state.json missing), it clears the session binding from `config.json` but leaves `topic-settings.json` untouched. When the user later runs `/new` in that DM, the new session inherits the existing `projectDir` from `topic-settings.json`. This is correct: the DM workspace preference is independent of any particular session.

## File Changes

### New: `src/sessions/paths.ts` entry

- `topicSettingsPath(home)` — returns `$GOBLIN_HOME/topic-settings.json`

### New: `src/sessions/topic-settings.ts`

- `TopicSettingsFile` interface: `{ topics?: Record<string, Record<string, { projectDir?: string }>>; dm?: Record<string, { projectDir?: string }>; supergroups?: Record<string, { projectDir?: string }>; }`. Default structure when file is missing: `{ topics: {}, dm: {}, supergroups: {} }`.
- `loadTopicSettings(home)` — returns default if missing
- `saveTopicSettings(home, settings)` — atomic write with random tmp name
- `getProjectDir(home, locator)` — reads the setting for a chat surface
- `bindProjectDir(home, locator, projectDir)` — updates and saves atomically

Traces to:
- **Requirement: Topic settings file**
- **Requirement: Get projectDir from binding**
- **Requirement: Bind projectDir to chat surface**
- **Requirement: Topic settings atomic write**

### Modified: `src/sessions/paths.ts`

- Add `topicSettingsPath(home)` export.

Traces to:
- **Requirement: Topic settings file**

### Modified: `src/sessions/types.ts`

- `SessionState` — `projectDir?: string` is deprecated. Code stops reading/writing it. The field may remain in existing `state.json` files during migration, but new sessions do not include it.

Traces to:
- **Requirement: session-scoped projectDir** (REMOVED)

### Modified: `src/sessions/manager.ts`

- Add `getProjectDir(locator)` — delegates to `getProjectDir(home, locator)` from `topic-settings.ts`
- `setProjectDir(sessionId, dir)` → `bindProjectDir(locator, dir)` — new method name to avoid signature collision. Accepts `ChatLocator` instead of `sessionId`. Updates `topic-settings.json`, not `state.json`.
- `createForChat()` — stop including `projectDir` in new `SessionState`
- `resolve()` — when recreating stale topic sessions, new `SessionState` has no `projectDir`

Traces to:
- **Requirement: Auto-create sessions for topics on first resolve** (MODIFIED)
- **Requirement: Handle stale bindings for topics by recreating** (MODIFIED)

### Modified: `src/bot.ts`

- `createRunner(session, locator, ctx)` — read `projectDir` via `manager.getProjectDir(locator)` instead of `session.projectDir`
- `/project` handler — pass `locator` to `executeProject` and `manager.bindProjectDir(locator, dir)` instead of `manager.setProjectDir(session.id, dir)`

Traces to:
- **Requirement: /project binds chat surface to directory** (MODIFIED)
- **Requirement: AgentRunner uses projectDir for cwd and agentDir** (unchanged interface, new source)

### Modified: `src/commands/project.ts`

- `ProjectCommandDeps.setProjectDir` signature changes from `(dir?: string) => void` to `(locator: ChatLocator, dir?: string) => void`... actually, no — `executeProject` doesn't know the locator. The callback is injected by `bot.ts`, which has the locator. So the callback signature stays `(dir?: string) => void` — `bot.ts` closes over `locator`.
- Wait, re-reading: `executeProject` receives `setProjectDir: (dir) => { ... }` from bot.ts. Bot.ts already has `locator` in scope. So `executeProject` itself needs no change. Only `bot.ts` changes what the callback does.

Actually, re-reading `project.ts`, `setProjectDir` is a callback: `setProjectDir: (dir) => { manager.setProjectDir(session.id, dir); ... }`. `bot.ts` will change this to `manager.setProjectDir(locator, dir)`. `project.ts` itself needs no changes.

### Modified: `src/commands/project.test.ts`

- Tests mock `setProjectDir` callback — no signature change needed, but add a test verifying the callback receives the correct dir after binding-scope change.

### Modified: `src/sessions/manager.test.ts`

- Remove `setProjectDir` session tests (those move to a new `topic-settings.test.ts`)
- Add tests for `getProjectDir` delegation

### New: `src/sessions/topic-settings.test.ts`

- Load/save roundtrip
- Get/set per-topic and per-DM
- Atomic write verification

### Modified: `specs/canon/sessions/spec.md`

- Remove `session-scoped projectDir` requirement

### Modified: `specs/canon/project-command/spec.md`

- Update `/project` requirement to say binding-scoped instead of session-scoped
- Update `session state persistence` to `binding state persistence`

### Modified: `specs/canon/agent-runner-project-dir/spec.md`

- Remove `session-scoped projectDir` requirement
- Update `AgentRunner uses projectDir` to note source is binding

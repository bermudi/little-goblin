# Design

## Architecture

The little-goblin scaffold follows a layered architecture:

```
┌─────────────────────────────────────────────────────────────┐
│  src/index.ts (entry point)                                  │
│    - loadConfig() → ensureGoblinHome() → buildBot()         │
│    - signal handling → bot.start() (long-polling)             │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  src/bot.ts (orchestration)                                  │
│    - constructs grammy Bot                                  │
│    - wires allowlist middleware (security layer)             │
│    - registers command handlers                              │
│    - error handling via bot.catch()                         │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ src/tg/      │    │ src/commands/│    │ src/sessions/│
│ - middleware │    │ - ping.ts    │    │ - manager.ts │
│ - locator    │    │ - new.ts     │    │ - state.ts   │
└──────────────┘    └──────────────┘    │ - bindings.ts│
                                        │ - paths.ts   │
                                        └──────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Shared concerns:                                            │
│    - src/config.ts (env loading, GOBLIN_HOME setup)          │
│    - src/log.ts (structured logging)                        │
│    - src/agent/models.ts (model registry)                    │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Patterns

1. **Security-first allowlist**: All messages pass through allowlist middleware before any command handler. Non-allowed users are silently dropped (no confirmation of bot existence).

2. **Atomic persistence**: All file writes use temp-file + rename pattern for crash safety. This applies to `state.json` and `config.json`.

3. **ChatLocator abstraction**: Normalizes Telegram's complex chat/thread model into a simple `{chatId, topicId?}` structure. DMs have no topicId; forum topics have both.

4. **Session auto-creation asymmetry**: Topics auto-create sessions on first message (fire-and-forget); DMs require explicit `/new` command (intentional action).

5. **Orphan session preservation**: Rebinding a DM creates a new session but leaves old session directories intact. Sessions are append-only for audit/debug purposes.

## Decisions

### Decision: Use Bun's built-in .env loading
- **Chosen**: Rely on Bun's automatic `.env` loading from cwd in dev; use `--env-file` flag in production
- **Rationale**: No extra dependency, Bun's parser handles exports/quotes/multiline correctly
- **Trade-off**: Less explicit than dotenv library; requires documenting the production pattern

### Decision: Silent allowlist failures
- **Chosen**: Drop non-allowed messages without response
- **Rationale**: Prevents confirming bot existence to attackers; keeps logs for debugging
- **Trade-off**: Users with stale allowlists get no feedback (check debug logs)

### Decision: 10-char hex session IDs
- **Chosen**: First 10 hex chars of UUID v4 (16^10 ≈ 1.1T combos)
- **Rationale**: Short enough for human use, long enough to avoid collisions, filesystem-safe
- **Trade-off**: Not lexicographically sortable by time (use createdAt for sorting)

### Decision: JSON for state, JSONL for logs
- **Chosen**: JSON for structured state (bindings, state.json); JSONL for append-only logs (events, transcript)
- **Rationale**: JSON supports atomic replace; JSONL supports efficient append
- **Trade-off**: Two formats to understand; no query capabilities

### Decision: ENOENT-as-normal pattern
- **Chosen**: Missing files return null/defaults rather than throwing
- **Rationale**: Simplifies first-run experience; atomic writes mean partial files are impossible
- **Trade-off**: Silent failures if files are accidentally deleted (mitigated by stale binding detection)

## File Changes

No source files are modified in this change — this is a documentation-only adoption of existing behavior.

Artifacts created:
- `specs/changes/adopt-existing-scaffold/proposal.md` - scope and motivation
- `specs/changes/adopt-existing-scaffold/specs/config/spec.md` - configuration requirements
- `specs/changes/adopt-existing-scaffold/specs/logging/spec.md` - logging requirements  
- `specs/changes/adopt-existing-scaffold/specs/telegram/spec.md` - telegram layer requirements
- `specs/changes/adopt-existing-scaffold/specs/sessions/spec.md` - session management requirements
- `specs/changes/adopt-existing-scaffold/specs/commands/spec.md` - command handler requirements
- `specs/changes/adopt-existing-scaffold/specs/models/spec.md` - model registry requirements
- `specs/changes/adopt-existing-scaffold/specs/orchestration/spec.md` - startup/shutdown requirements
- `specs/changes/adopt-existing-scaffold/design.md` - architecture documentation

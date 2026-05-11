# Migration: Binding-Scoped Project Directory

## What changed

`/project` now persists the project directory binding in `topic-settings.json` (per-chat-surface) instead of `state.json` (per-session). This means `/new` no longer discards the project directory.

## Before → After

| File | Before | After |
|---|---|---|
| `sessions/<id>/state.json` | `projectDir: "/path"` | No `projectDir` field |
| `topic-settings.json` | Didn't exist | `{ topics: { "chatId": { "topicId": { "projectDir": "/path" } } } }` |

## Migration steps

1. Run the migration script from the project root:

```sh
bun run specs/changes/binding-scoped-project-dir/migrate.ts
```

2. The script will:
   - Scan all sessions for `projectDir` in `state.json`
   - Look up which binding (DM/topic/supergroup) points to each session
   - Write the `projectDir` to `topic-settings.json` under the correct surface key
   - Strip `projectDir` from `state.json`
   - Skip orphaned sessions (no active binding) with a log message

3. Verify: send a message in a topic that previously had a project directory. The agent should still be operating in that directory. `/new` should preserve the binding.

## Idempotency

Safe to run multiple times. Sessions already stripped of `projectDir` are skipped.

## Rollback

If something goes wrong before you've verified, restore from the session state backups. The migration script writes atomically (tmp + rename) so partial writes aren't a concern. You can also manually reconstruct `projectDir` in `state.json` from the `topic-settings.json` output.

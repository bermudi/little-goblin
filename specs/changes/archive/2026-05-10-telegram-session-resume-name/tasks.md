# telegram-session-resume-name — Tasks

## Phase 1: Terminology and session manager support

- [x] Update `specs/glossary.md` with bound session, unbound session, resumable session, and archived session.
- [x] Add `SessionManager.setTitle(sessionId, title)` to persist `SessionState.title` atomically.
- [x] Add `SessionManager.bindExistingToChat(sessionId, locator, opts)` to bind the current Telegram surface to an existing resumable session without creating/deleting/archiving sessions.
- [x] Add or update `SessionManager` tests for title persistence, existing-session rebinding, and old session preservation.

## Phase 2: Fix `/new` semantics

- [x] Change `/new` so it does not call `manager.archive()` on the previously bound session.
- [x] Preserve interrupt/cascade semantics for `/new`.
- [x] Dispose and remove the previous runner after the fresh session is bound.
- [x] Update `/new` command tests/integration tests to assert the previous session remains under `sessions/<old-id>/` and is included by `manager.list()`.
- [x] Update specs/canon deltas after implementation/archive phase as appropriate.

## Phase 3: Telegram `/name` and `/resume`

- [x] Add `/name <name>` command helper and tests.
- [x] Add `/resume <id-or-name>` command helper and tests.
- [x] Route `/name` and `/resume` in `bot.ts`'s `message:text` command switch.
- [x] Add both commands to `CANCEL_CAPABLE_COMMANDS`.
- [x] Ensure `/resume` searches resumable sessions (non-archived direct children of `sessions/`), including unbound sessions left behind by `/new`.
- [x] Ensure `/resume` does not search `sessions/archive/`.
- [x] Make `/resume` with no arguments list named resumable sessions.
- [x] Dispose the prior runner when `/resume` switches away from the currently bound session.
- [x] Update `/help` output and tests.
- [x] Add integration test for `/name ttt` → `/new` → `/resume ttt`.

## Phase 4: Verification

- [x] `bun test src/commands src/sessions`
- [x] `bun run typecheck`

Verified output:

```text
105 pass
0 fail
236 expect() calls
Ran 105 tests across 14 files.

TYPECHECK_EXIT:0
```

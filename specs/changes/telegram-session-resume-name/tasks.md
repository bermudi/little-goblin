# telegram-session-resume-name — Tasks

## Phase 1: Session manager support

- [x] Add `SessionManager.setTitle(sessionId, title)` to persist `SessionState.title` atomically.
- [x] Add `SessionManager.bindExistingToChat(sessionId, locator, opts)` to bind the current Telegram surface to an existing session without deleting the previously bound session.
- [x] Add unit tests for title persistence and existing-session rebinding.

## Phase 2: Telegram command surface

- [x] Add `/name <name>` command helper and tests.
- [x] Add `/resume <id-or-name>` command helper and tests.
- [x] Route `/name` and `/resume` in `bot.ts`'s `message:text` command switch.
- [x] Add both commands to `CANCEL_CAPABLE_COMMANDS`.
- [x] Dispose the prior runner when `/resume` switches away from the currently bound session.
- [x] Update `/help` output and tests.

## Verification

- [x] `bun test src/commands src/sessions`

Verified output:

```text
105 pass
0 fail
229 expect() calls
Ran 105 tests across 14 files.
```

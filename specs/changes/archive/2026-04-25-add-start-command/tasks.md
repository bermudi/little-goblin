## Phase 1: Add /start command handler

- [x] Create `src/commands/start.ts` with `buildStartHandler(manager: SessionManager)`
  - Implements DM session creation with welcome reply
  - Implements topic already-session reply
  - Implements plain-group rejection
  - Implements locator-missing fallback
- [x] Modify `src/commands/mod.ts` to import `buildStartHandler` and register `bot.command("start", …)`
- [x] Create `src/commands/start.test.ts` covering DM, topic, and plain-group scenarios with mocked `Context` and `SessionManager`
- [x] Run `bun test` to verify all tests pass

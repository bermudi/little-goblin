## Architecture

`/start` is a Telegram-native entry-point command. It follows the same chat-type discrimination logic as `/new` but with user-facing messages tailored to first contact. The handler lives in `src/commands/start.ts` and is registered in `src/commands/mod.ts`, preserving the existing pattern where `registerCommands()` is the single wiring point.

Data flow:
1. User sends `/start` → grammy `bot.command("start", …)` matches before `message:text`.
2. Handler resolves `ChatLocator` via `locatorFromCtx(ctx)`.
3. If locator is missing → reply with fallback error.
4. Handler discriminates chat type (private / topic / plain group) and replies accordingly.
5. In a DM, it calls `manager.createForChat(loc)` and replies with a welcome message containing the session ID.

## Decisions

### Reuse `buildNewHandler` pattern vs. shared helper

**Chosen:** Write a standalone `buildStartHandler(manager)` in `src/commands/start.ts` that mirrors `buildNewHandler` structure.

**Rationale:** The message text and intent differ (`/start` is onboarding, `/new` is explicit reset). A shared helper would couple two commands that the proposal explicitly keeps separate. Duplicating the 10-line discrimination boilerplate is acceptable; it keeps each command self-contained and easy to evolve independently.

### Welcome message content

**Chosen:** `Session \`<id>\` ready\. Just start typing\!` (MarkdownV2).

**Rationale:** Short, action-oriented, and consistent with the existing `MarkdownV2` reply style used by `/new`. It tells the user exactly what to do next without unnecessary prose.

### Test coverage

**Chosen:** Add `src/commands/start.test.ts` with three scenarios (DM, topic, plain group) using mocked `Context` and `SessionManager`.

**Rationale:** Command handlers are pure async functions over grammy context — cheap to unit test. No existing command tests exist, but the `bun:test` + mock pattern is already used for `sessions/manager.test.ts`. Testing the handler prevents silent regressions in the onboarding path.

## File Changes

| File | Change | Requirement covered |
|------|--------|-------------------|
| `src/commands/start.ts` | **Create** `buildStartHandler(manager)` function. Implements DM session creation, topic already-session message, plain-group rejection, and locator-missing fallback. | Implement /start command for DM session creation; Reject /start in non-forum groups; Handle /start in forum topic; Handle indeterminate chat context for /start |
| `src/commands/mod.ts` | **Modify** `registerCommands()` to add `bot.command("start", buildStartHandler(manager))`. | Register command handlers on bot |
| `src/commands/start.test.ts` | **Create** unit tests for DM, topic, and plain-group scenarios. | (regression coverage) |

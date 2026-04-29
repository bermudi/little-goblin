# Session Commands & Cancel — Tasks

## Phase 1: Command detection and routing

- [ ] In `src/bot.ts` message handler, add command detection: check if `ctx.message.text.startsWith('/')`.
- [ ] Parse command: `const command = ctx.message.text.split(' ')[0]`.
- [ ] Add switch/case or router for commands: `/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent`, `/revive`, `/help`.
- [ ] For unknown slash-commands: fall through to normal agent routing (don't reply "Unknown command").
- [ ] Add basic `/cancel` implementation: reply "Cancelled" and return (interrupt logic comes in phase 2).
- [ ] Remove `bot.command("new")` from `src/commands/mod.ts` — `/new` is now handled in `bot.ts` text handler. Keep `ping` and `start` registrations.
- [ ] Delete or leave `src/commands/new.ts` as dead code.
- [ ] Verify `bun run typecheck` passes.

Commit: `phase 1: command detection and basic routing`

## Phase 2: Interrupt semantics (abort on command with cascade)

- [ ] Implement interrupt check: for `/cancel`, `/new`, `/archive`, `/debug`, check if `runner?.isStreaming`.
- [ ] If streaming: call `await runner.abort()` before executing command logic.
- [ ] Implement cascade-cancel: abort all live subagents before executing command logic.
  - Use `subagentRunner.list().filter(s => s.status === "running")` to enumerate live subagents.
  - Call `subagentRunner.cancel(id)` on each, via `Promise.all` with individual `.catch()` (best-effort, don't block command on a stuck subagent).
  - Await all subagent aborts before proceeding to command logic.
- [ ] Note: `AgentRunner.session.isStreaming` is already available via pi's `AgentSession`. No new getter needed — access via `runner.session?.isStreaming` or store a local `isStreaming` flag.
- [ ] Unit test: verify abort is called when streaming, verify command executes after abort.
- [ ] Unit test: verify cascade-cancel aborts all live subagents.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: interrupt semantics with cascade cancel`

## Phase 3: /cancel command

- [ ] Implement `/cancel` command:
  - If streaming: abort (with cascade from phase 2), reply "Cancelled."
  - If idle: reply "Nothing to cancel."
  - If no active session: reply "Nothing to cancel."
- [ ] Ensure it works in both DMs and topics.
- [ ] Unit test: verify behavior in all three states (streaming, idle, no session).
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: /cancel command implementation`

## Phase 4: /new command

- [ ] Implement `/new` command:
  - Interrupt if streaming (with cascade from phase 2).
  - Handle topic case: reply "This topic is already its own session. No need for /new here."
  - Handle DM case: call `sessionManager.createForChat(locator)`, reply with new session ID.
  - Handle no-session case: same as DM case (creates a session).
- [ ] Unit test: verify session creation, verify interrupt behavior, verify topic rejection.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: /new command for DM sessions`

## Phase 5: /archive command

- [ ] Add `sessionManager.archive(sessionId)` method to `src/sessions/manager.ts`:
  - Move session directory from `sessions/<id>/` to `sessions/archive/<id>/` via `renameSync`.
  - Remove the binding for this session from the chat's `config.json`.
  - Throw if source directory doesn't exist (already archived).
- [ ] Implement `/archive` command:
  - Interrupt if streaming (with cascade from phase 2).
  - Check for no active session: reply "No active session to archive."
  - Check if `sessions/<id>/` exists: if not, reply "Session already archived."
  - Call `sessionManager.archive(session.id)`.
  - In topics: rename topic to final title via `bot.api.setForumTopicName`.
  - Reply "Session archived."
- [ ] Unit test: verify archive moves files, clears binding, handles already-archived, handles no-session.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: /archive command with topic renaming`

## Phase 6: /debug command

- [ ] Create `src/diagnostics.ts` with `generateDiagnostics(session, runner, subagentRunner)`:
  - Gather: session ID, current model, active tools, loaded skills count (best-effort), events.jsonl path, events.jsonl size/line count, active subagent count.
  - Format as human-readable text.
  - Fields that cannot be discovered (loaded skills, context token count) SHALL show "unavailable".
- [ ] Implement `/debug` command:
  - Interrupt if streaming (with cascade from phase 2).
  - Check for no active session: reply "No active session."
  - Call `generateDiagnostics`.
  - Reply with formatted diagnostics.
- [ ] Unit test: verify diagnostics content includes expected fields.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: /debug command with diagnostics`

## Phase 7: Subagent command surface (stub)

- [ ] Implement `/subagents` command: reply with stub "Not implemented".
- [ ] Implement `/cancel_subagent <id>`: parse ID from args, reply "Not implemented".
- [ ] Implement `/revive <id>`: parse ID, reply "Not implemented".
- [ ] These are surface-only; implementation in `subagent-runtime` change.
- [ ] Unit test: verify command parsing and stub responses.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 7: subagent command surface (stubs)`

## Phase 8: Integration and polish

- [ ] Ensure all commands work in both DMs and topics.
- [ ] Implement `/help` command: reply with list of all available commands.
- [ ] Review error messages for clarity.
- [ ] Smoke test end-to-end: run bot, test each command.
- [ ] Verify `bun run typecheck` + `bun test` pass.

### Test infrastructure note
Use `vitest` `mock.module` for `@mariozechner/pi-coding-agent` and `SubagentRunner` (pattern: see `src/agent/mod.test.ts`). Use `mkdtempSync` for `SessionManager` tests (pattern: see `src/sessions/manager.test.ts`).

Commit: `phase 8: command polish and /help`

## Phase 9: Validate and archive

- [ ] `litespec validate session-commands-cancel` (strict).
- [ ] Review spec deltas vs implementation.
- [ ] `litespec preview session-commands-cancel`.
- [ ] `litespec archive session-commands-cancel` when satisfied.

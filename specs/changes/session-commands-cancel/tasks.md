# Session Commands & Cancel — Tasks

## Phase 1: Command detection and routing

- [x] In `src/bot.ts` message handler, add command detection: check if `ctx.message.text.startsWith('/')`.
- [x] Parse command: `const command = ctx.message.text.split(' ')[0]`.
- [x] Add switch/case or router for commands: `/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent`, `/revive`, `/help`.
- [x] For unknown slash-commands: fall through to normal agent routing (don't reply "Unknown command").
- [x] Add basic `/cancel` implementation: reply "Cancelled" and return (interrupt logic comes in phase 2).
- [x] Remove `bot.command("new")` from `src/commands/mod.ts` — `/new` is now handled in `bot.ts` text handler. Keep `ping` and `start` registrations.
- [x] Delete or leave `src/commands/new.ts` as dead code.
- [x] Verify `bun run typecheck` passes.

Commit: `phase 1: command detection and basic routing`

## Phase 2: Interrupt semantics (abort on command with cascade)

- [x] Implement interrupt check: for `/cancel`, `/new`, `/archive`, `/debug`, check if `runner?.isStreaming`.
- [x] If streaming: call `await runner.abort()` before executing command logic.
- [x] Implement cascade-cancel: abort all live subagents before executing command logic.
  - Use `subagentRunner.list().filter(s => s.status === "running")` to enumerate live subagents.
  - Call `subagentRunner.cancel(id)` on each, via `Promise.all` with individual `.catch()` (best-effort, don't block command on a stuck subagent).
  - Await all subagent aborts before proceeding to command logic.
- [x] Note: `AgentRunner.session.isStreaming` is already available via pi's `AgentSession`. No new getter needed — access via `runner.session?.isStreaming` or store a local `isStreaming` flag. _Implementation note: added an `isStreaming` getter on `AgentRunner` because `session` is private; the helper takes a structural `InterruptableRunner` shape so tests stay light._
- [x] Unit test: verify abort is called when streaming, verify command executes after abort.
- [x] Unit test: verify cascade-cancel aborts all live subagents.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: interrupt semantics with cascade cancel`

## Phase 3: /cancel command

- [x] Implement `/cancel` command:
  - If streaming: abort (with cascade from phase 2), reply "Cancelled."
  - If idle: reply "Nothing to cancel."
  - If no active session: reply "Nothing to cancel."
- [x] Ensure it works in both DMs and topics. _The /cancel handler reads only `session`, `wasStreaming`, and `hadLiveSubagents` — none of which depend on chat type, so DMs and topics share identical behavior._
- [x] Unit test: verify behavior in all three states (streaming, idle, no session). _Plus two extras: idle-but-live-subagents and the streaming+subagents combo._
- [x] Verify `bun run typecheck` + `bun test` pass.

_Implementation note: the helper also returns "Cancelled." when the main agent is idle but live subagents existed pre-interrupt. The cascade kills them, so reporting "Nothing to cancel." would be a lie._

Commit: `phase 3: /cancel command implementation`

## Phase 4: /new command

- [x] Implement `/new` command:
  - Interrupt if streaming (with cascade from phase 2).
  - Handle topic case: reply "This topic is already its own session. No need for /new here."
  - Handle DM case: call `sessionManager.createForChat(locator)`, reply with new session ID.
  - Handle no-session case: same as DM case (creates a session).
- [x] Unit test: verify session creation, verify interrupt behavior, verify topic rejection. _Helper-level tests pin topic rejection and the create branch (+ the no-prior-session fresh-start contract). Interrupt behavior is already covered by `interruptAndCascade` tests in phase 2; `/new` is in `CANCEL_CAPABLE_COMMANDS` so it inherits that path._
- [x] Verify `bun run typecheck` + `bun test` pass.

_Implementation note: the bot.ts `/new` branch passes `isSupergroup: ctx.chat?.type === "supergroup"` to `manager.createForChat` so a `/new` issued in a supergroup-without-topic rebinds the supergroup slot rather than accidentally creating a DM binding. The design.md snippet omitted this; it's a strict superset that mirrors `start.ts`._

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

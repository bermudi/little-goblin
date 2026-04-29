# Session Commands & Cancel — Tasks

## Phase 1: Command detection and routing

- [ ] In `src/bot.ts` message handler, add command detection: check if `ctx.message.text.startsWith('/')`.
- [ ] Parse command: `const command = ctx.message.text.split(' ')[0]`.
- [ ] Add switch/case or router for commands: `/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent`, `/revive`.
- [ ] For unknown commands: reply "Unknown command" and return.
- [ ] Add basic `/cancel` implementation: reply "Cancelled" and return (interrupt logic comes in phase 2).
- [ ] Verify `bun run typecheck` passes.

Commit: `phase 1: command detection and basic routing`

## Phase 2: Interrupt semantics (abort on command with cascade)

- [ ] Implement interrupt check: for `/cancel`, `/new`, `/archive`, `/debug`, check if `runner?.isStreaming`.
- [ ] If streaming: call `await runner.abort()` before executing command logic.
- [ ] Implement cascade-cancel: abort all live subagents before executing command logic.
  - Iterate `SubagentRunner.liveSubagents()` (or equivalent), call `abort()` on each.
  - Await all subagent aborts before proceeding to command logic.
- [ ] Add `runner?.isStreaming` getter to `AgentRunner` if not already present.
- [ ] Unit test: verify abort is called when streaming, verify command executes after abort.
- [ ] Unit test: verify cascade-cancel aborts all live subagents.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: interrupt semantics with cascade cancel`

## Phase 3: /cancel command

- [ ] Implement `/cancel` command:
  - If streaming: abort, reply "Cancelled."
  - If idle: reply "Nothing to cancel."
- [ ] Ensure it works in both DMs and topics.
- [ ] Unit test: verify behavior in both states.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: /cancel command implementation`

## Phase 4: /new command

- [ ] Implement `/new` command:
  - Interrupt if streaming (from phase 2).
  - Call `sessionManager.createForChat(locator, {title: optional})`.
  - Reply with new session ID and confirmation.
- [ ] Handle DM case explicitly (topic case is auto-create, doesn't need /new).
- [ ] Unit test: verify session creation, verify interrupt behavior.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: /new command for DM sessions`

## Phase 5: /archive command

- [ ] Implement `/archive` command:
  - Interrupt if streaming.
  - Move session directory from `sessions/<id>/` to `sessions/archive/<id>/`.
  - Clear binding from `config.json`.
  - In topics: rename topic to final title via `bot.api.setForumTopicTitle`.
  - Reply "Session archived."
- [ ] Add `sessionManager.archive(sessionId)` method if not exists.
- [ ] Handle case where session already archived: reply error.
- [ ] Unit test: verify archive moves files, clears binding, renames topic.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: /archive command with topic renaming`

## Phase 6: /debug command

- [ ] Create `src/diagnostics.ts` with `generateDiagnostics(session, runner)`:
  - Gather: session ID, current model, active tools, loaded skills count, events.jsonl path, events.jsonl size/line count.
  - Format as human-readable text.
- [ ] Implement `/debug` command:
  - Interrupt if streaming.
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
- [ ] Add help text: `/help` command listing all available commands.
- [ ] Review error messages for clarity.
- [ ] Smoke test end-to-end: run bot, test each command.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 8: command polish and /help`

## Phase 9: Validate and archive

- [ ] `litespec validate session-commands-cancel` (strict).
- [ ] Review spec deltas vs implementation.
- [ ] `litespec preview session-commands-cancel`.
- [ ] `litespec archive session-commands-cancel` when satisfied.

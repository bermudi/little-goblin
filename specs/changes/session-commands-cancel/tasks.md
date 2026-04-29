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

_The `/new` branch passes `isSupergroup: ctx.chat?.type === "supergroup"` to `createForChat` so a `/new` issued in a supergroup-without-topic rebinds the supergroup slot rather than accidentally creating a DM binding. This mirrors `start.ts`._

Commit: `phase 4: /new command for DM sessions`

## Phase 5: /archive command

- [x] Add `sessionManager.archive(sessionId)` method to `src/sessions/manager.ts`:
  - Move session directory from `sessions/<id>/` to `sessions/archive/<id>/` via `renameSync`.
  - Remove the binding for this session from the chat's `config.json`.
  - Throw if source directory doesn't exist (already archived).
- [x] Implement `/archive` command:
  - Interrupt if streaming (with cascade from phase 2).
  - Check for no active session: reply "No active session to archive."
  - Check if `sessions/<id>/` exists: if not, reply "Session already archived."
  - Call `sessionManager.archive(session.id)`.
  - In topics: rename topic to final title via `bot.api.editForumTopic` (`setForumTopicName` does not exist on grammy's `Api`; the equivalent is `editForumTopic(chat_id, message_thread_id, { name })`).
  - Reply "Session archived."
- [x] Unit test: verify archive moves files, clears binding, handles already-archived, handles no-session. _Manager-level: DM/topic/supergroup binding clear, double-archive throw, `list()` ignores archive subtree. Helper-level (`commands/archive.test.ts`): three states + error propagation._
- [x] Verify `bun run typecheck` + `bun test` pass. _339 pass, 0 fail._

_Implementation notes:_
- _The `archive(id)` method also drops the runner from `bot.ts`'s in-memory `runners` map via the injected `archive` closure, so the next message in that chat creates a fresh runner instead of pointing at a moved session dir._
- _`SessionManager.list()` now skips the literal `archive` directory entry when scanning `sessions/` (was previously surviving by accident because `loadState(home, "archive")` returned null)._
- _Topic rename uses `editForumTopic`, not `setForumTopicName` (no such grammy method). Failures are logged but do not block the reply — the archive itself already succeeded by that point._

Commit: `phase 5: /archive command with topic renaming`

## Phase 6: /debug command

- [x] Create `src/diagnostics.ts` with `generateDiagnostics(deps)`:
  - Gather: session ID, createdAt, current model, active tools, loaded skills count (best-effort), events.jsonl path, events.jsonl size/line count, total + running subagent count, context token usage (best-effort).
  - Format as human-readable text.
  - Fields that cannot be discovered (loaded skills, context token count) SHALL show "unavailable".
- [x] Implement `/debug` command:
  - Interrupt if streaming (with cascade from phase 2). _`/debug` is in `CANCEL_CAPABLE_COMMANDS` so it inherits this from `interruptAndCascade`._
  - Check for no active session: reply "No active session."
  - Call `generateDiagnostics`.
  - Reply with formatted diagnostics.
- [x] Unit test: verify diagnostics content includes expected fields. _Split into `formatDiagnostics` (deterministic snapshot → string) and `gatherDiagnostics` (real fs + stub runner/subagent). 11 new assertions in `src/diagnostics.test.ts`._
- [x] Verify `bun run typecheck` + `bun test` pass. _350 pass, 0 fail._

_Implementation notes:_
- _`Diagnostics` is a structured snapshot, formatted by a separate pure function. This makes the format trivially testable without spinning up an `AgentSession`._
- _Added `AgentRunner.getActiveToolNames()` (passes through to pi's `AgentSession.getActiveToolNames()`) and `AgentRunner.modelName` so diagnostics doesn't have to reach into private state. Tools are `null` (rendered "unavailable") until the first prompt initializes the session, since pi only knows tool names after `createAgentSession`._
- _`skillsLoaded` and `contextTokens` are deliberately wired as `null` for now — pi exposes no API to query them. The fields are present in `Diagnostics` so they appear in the formatted output as "unavailable" rather than being silently dropped, matching the spec's "shown as 'unavailable' if not exposed by the API"._
- _`/debug` reads only `existingRunner` (the resolved-but-non-creating lookup), so diagnostics for a brand-new session-with-no-runner will show `Tools: unavailable` rather than spuriously creating a runner just to populate the field._
- _Events file stats use `statSync` for size + `readFileSync().split("\n").filter(Boolean).length` for lines. ENOENT and any read error are swallowed → null fields. Fine at v1; if events.jsonl ever grows into the hundreds of MB this becomes a streaming-line-count problem._

Commit: `phase 6: /debug command with diagnostics`

## Phase 7: Subagent command surface (stub)

- [x] Implement `/subagents` command: reply with stub "Not implemented".
- [x] Implement `/cancel_subagent <id>`: parse ID from args, reply "Not implemented". _Parsing extracted to `parseSubagentId` in `src/commands/subagents.ts` so the eventual real handler has a stable, tested call-site._
- [x] Implement `/revive <id>`: parse ID, reply "Not implemented".
- [x] These are surface-only; implementation in `subagent-runtime` change.
- [x] Unit test: verify command parsing and stub responses. _See `src/commands/subagents.test.ts`: 5 parsing assertions + 1 pinning the literal stub reply._
- [x] Verify `bun run typecheck` + `bun test` pass. _356 pass, 0 fail._

Commit: `phase 7: subagent command surface (stubs)`

## Phase 8: Integration and polish

- [x] Ensure all commands work in both DMs and topics. _Sweep: `/cancel` reads only `session`/`wasStreaming`/`hadLiveSubagents` — chat-type independent. `/new` uses `hasTopic` to refuse in topics, creates in DM/supergroup-no-topic. `/archive` runs in both, additionally renames the topic via `editForumTopic` when `locator.topicId !== undefined`. `/debug`, `/subagents`, `/cancel_subagent`, `/revive`, `/help` have no chat-type branches._
- [x] Implement `/help` command: reply with list of all available commands. _`HELP_REPLY` constant in `src/commands/help.ts`; lists all 8 commands with one-line descriptions, flags subagent commands as not yet implemented to pre-empt the "Not implemented" surprise._
- [x] Review error messages for clarity. _Cross-checked against spec literals: "Nothing to cancel.", "Cancelled.", "This topic is already its own session. No need for /new here.", "Created new session \`<id>\`", "No active session to archive.", "Session already archived.", "Session archived.", "No active session." (from /debug — matches spec scenario verbatim), "No active session. Use /new to start one." (DM fallthrough). All clear, consistent capitalization + period punctuation, and aligned with the spec scenarios._
- [ ] Smoke test end-to-end: run bot, test each command. _Requires a real `BOT_TOKEN` against Telegram — out of reach for this session. **User: please run `bun run dev`, then exercise `/cancel`, `/new`, `/archive`, `/debug`, `/subagents`, `/cancel_subagent <id>`, `/revive <id>`, `/help` in a DM and a forum topic, and report any rough edges.**_
- [x] Verify `bun run typecheck` + `bun test` pass. _359 pass, 0 fail._

### Test infrastructure note
Use `vitest` `mock.module` for `@mariozechner/pi-coding-agent` and `SubagentRunner` (pattern: see `src/agent/mod.test.ts`). Use `mkdtempSync` for `SessionManager` tests (pattern: see `src/sessions/manager.test.ts`).

Commit: `phase 8: command polish and /help`

## Phase 9: Validate and archive

- [ ] `litespec validate session-commands-cancel` (strict).
- [ ] Review spec deltas vs implementation.
- [ ] `litespec preview session-commands-cancel`.
- [ ] `litespec archive session-commands-cancel` when satisfied.

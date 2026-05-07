# manual-compaction — Tasks

## Phase 1: Wire compaction through agent layer

- [ ] Add `compaction_start` case to `dispatchAgentEvent` in `src/agent/events.ts` — invokes `callbacks.onStatusUpdate("🗜 compacting…")`
- [ ] Add `compaction_end` case to `dispatchAgentEvent` in `src/agent/events.ts` — formats tokens-before from `event.result` and invokes `callbacks.onStatusUpdate(…)`
- [ ] Update `dispatchAgentEvent` doc comment and existing "Unknown event type" scenario test comment to reflect that `compaction_start` is now a recognized (not ignored) event
- [ ] Add test cases in `src/agent/events.test.ts` for `compaction_start` and `compaction_end` dispatch
- [ ] Add `compact(customInstructions?: string)` method to `AgentRunner` in `src/agent/mod.ts` — calls `init()`, then delegates to `this.session.compact()`
- [ ] Add test in `src/agent/mod.test.ts` verifying `compact()` delegates to session (mock pi session)
- [ ] Run `bun test src/agent/` to confirm all agent tests pass

**Commit:** `phase 1: wire compaction through agent layer`

**Covers:** ADDED "AgentRunner exposes compact()", MODIFIED "Shared event dispatch function in agent/events.ts"

## Phase 2: Register /compact command

- [ ] Add `"/compact"` to `CANCEL_CAPABLE_COMMANDS` set in `src/bot.ts`
- [ ] Add `/compact` case in the switch — extract optional instructions from `rawText` (everything after `/compact `), call `existingRunner.compact(instructions)`, reply with `"Compacted from ~<tokens>K tokens."` on success or pi's error message on failure
- [ ] Handle no-session edge case: reply `"No active session to compact."`
- [ ] Handle no-runner edge case: reply `"No active runner to compact."`
- [ ] Add test cases in `src/commands/integration.test.ts` (or create `src/commands/compact.test.ts` if inline testing is cleaner)
- [ ] Update `HELP_REPLY` in `src/commands/help.ts` to include `/compact` in the commands list
- [ ] Run `bun test` to confirm full test suite passes

**Commit:** `phase 2: register /compact command`

**Covers:** ADDED "Compact command triggers manual context compaction", ADDED "Compact command is registered as a cancel-capable command"

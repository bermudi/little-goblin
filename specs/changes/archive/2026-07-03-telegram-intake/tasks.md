## Phase 1: Telegram intake module (adopted)

The intake module is implemented and green. These tasks document the structure that landed for traceability.

- [x] `src/tg/intake.ts` exports `createTelegramIntake(options)` returning `handleText`, `handlePhoto`, `handleDocument`, `handleVoice`, `handleAudio`, `handleTopicDescription`
- [x] `resolveActiveTurn(message, kind)` resolves locator → session → `ActiveTurn` with scheduling closure; drops on null locator; DM-replies / topic-drops on no session
- [x] `schedulePrompt(session, runner, run, onError)` enforces per-session promise queue + `isCurrent` stale-runner guard
- [x] `handleText` dispatches commands via `handleCommand`, applies `runner-created` / `runner-disposed` / `queue-prompt` side effects, then branches on `isStreaming` (steer via `followUp` with `"not streaming"` fallback to fresh turn; idle → fresh turn)
- [x] `downloadFileBytes` / `downloadFile` / `downloadPhoto` with 20 MiB cap and null-on-failure contract
- [x] Document / voice / audio saving into `projectDir` with safe-name normalization and no-`projectDir` fallback paths
- [x] Export message-shaped `replyNoActiveSession(message, locator, kind)`; `downloadFileBytes` for reuse

Implements spec requirements:
- **Intake resolves an active turn once per media update**
- **Intake serializes per-session turns with a stale-runner guard**
- **Intake applies the steer-vs-queue policy for text**
- **Intake downloads media under a size cap**
- **Intake saves documents, voice, and audio into the project directory**
- **Intake applies command side effects to the runner cache**

## Phase 2: Thin grammy adapter (adopted)

- [x] `src/bot.ts` rewritten (~713 → ~163 lines): `buildBot` constructs `Bot` / `SessionManager` / `SubagentRunner` / `MemoryStore`, calls `createTelegramIntake`, mounts allowlist, registers commands, wires seven one-line `bot.on(...)` handlers
- [x] `intakeMessageFromCtx(ctx)` builds a `TelegramIntakeMessage` (locator, isSupergroup, threadId, reply, prepare)
- [x] ctx-shaped `replyNoActiveSession(ctx, locator, kind)` shim forwards to intake's message-shaped implementation
- [x] `buildBot` returns `{ bot, manager, subagentRunner, agentRunners: runners }` (shape preserved for `index.ts`)

Implements spec requirements:
- **Telegram intake module owns the update-to-turn seam**
- **Agent turns do not block unrelated updates** (MODIFIED — policy attributed to intake)

## Phase 3: Intake seam tests (adopted)

- [x] `src/tg/intake.test.ts` with `MockAgentRunner`, fake `Bot["api"]`, `TelegramIntakeMessage`, injectable `createAgentRunner` / `createMessageBuffer`
- [x] Covers: command creation + idle prompt + streaming steer; runner-disposing side effects; `/queue` serialization; no-session DM-vs-topic; stale-runner photo drop; topic-tool scoping; document fallback without `projectDir`
- [x] `bun test src/tg/intake.test.ts` green (7/7)

## Phase 4: Prune redundant bot.test.ts coverage

`bot.test.ts` still drives 29 integration tests through `built.bot.handleUpdate(...)`. Several now duplicate coverage that `intake.test.ts` provides more cheaply at the seam. Prune the redundant cases; keep a thin end-to-end safety net through the adapter.

- [x] Audit `bot.test.ts` for cases whose behavior is fully covered by `intake.test.ts` (steer, `/queue`, stale-runner, no-session reply, runner-disposing side effects)
- [x] Remove the redundant cases; keep at least one end-to-end text + one end-to-end media case proving the adapter delegates correctly
- [x] Verify `bun test src/bot.test.ts` and full suite remain green

Pruned two cases fully covered at the intake seam: "stale media work does not prompt after a runner-disposing command" (intake.test.ts:259) and "/queue while streaming enqueues behind the running turn" (intake.test.ts:223). Kept 21 tests: the nonblocking-update-handler timing cases (unique adapter coverage), the `/queue` reply-text cases (idle/no-arg/no-session — adapter replies not asserted at intake), the photo/document/voice/audio save cases (e2e media coverage), and the command/allowlist/orphan cases. 888 pass / 0 fail.

## Phase 5: Verification

- [x] `bun test` full suite green (894 pass / 0 fail at adoption time; 888 pass / 0 fail post-prune)
- [x] `bun run src/index.ts` boots and polls without errors (manual, post-prune)

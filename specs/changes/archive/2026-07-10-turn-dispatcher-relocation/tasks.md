# Tasks

## Phase 1: Relocate the dispatcher and encapsulate the runners map

- [x] Create `src/orchestration/dispatcher.ts` by moving `TurnDispatcher` from `src/tg/turn-dispatcher.ts`. Make `runners` private. Add `getRunner(sessionId): AgentRunner | null` returning the current runner or null. Remove the internal `new MessageBuffer(...)` fallback at `turn-dispatcher.ts:135`; `createMessageBuffer` always delegates to `createMessageBufferFn`, which becomes mandatory at construction. Covers: `Turn serialization lives in the orchestration layer`, `Turn dispatcher runners map is encapsulated`. NOTE: the factory type is the opaque `TurnSink` (= `TurnCallbacks`, the subset of `MessageBuffer` that `runner.prompt` consumes), not `MessageBuffer` — so the dispatcher drops its `MessageBuffer` import entirely (design D2). Also added `hasRunner(sessionId)` since `intake.test.ts` needed the `has` check.
- [x] Delete `src/tg/turn-dispatcher.ts` (no re-export shim).
- [x] Update `src/tg/intake.ts`: import `TurnDispatcher` from `../orchestration/dispatcher.ts`; construct the dispatcher with a `createMessageBuffer` factory containing the `MessageBuffer` construction logic that previously lived in the dispatcher (`turn-dispatcher.ts:132-144`, including the `onTopicNotFound` orphan-archive hook). Replace `dispatcher.runners.get(session.id)` at `intake.ts:274, 381` with `dispatcher.getRunner(session.id)`. Covers: `Turn serialization lives in the orchestration layer` (intake injects factory), `Turn dispatcher runners map is encapsulated`. NOTE: the factory is now constructed inside `createTelegramIntake` (defaulting to the `MessageBuffer` builder when `options.createMessageBuffer` is absent) — this fixes the half-wired seam where prod `buildBot` never passed a factory and the dispatcher's internal fallback fired.
- [x] Update `src/bot.ts` (`bot.ts:21`) and `src/index.ts` imports of `TurnDispatcher` to the new path. NOTE: only `bot.ts` imported the type; `index.ts` references `TurnDispatcher` in a comment only and receives the instance via `buildBot`'s return — no import to update there.
- [x] Run `bun run typecheck` and fix all broken import paths.

Commit: `phase 1: relocate TurnDispatcher to orchestration`

## Phase 2: Decouple the scheduler from the Telegram layer

- [x] Update `src/scheduler/loop.ts`: delete `import type { TurnDispatcher } from "../tg/turn-dispatcher.ts"` (`loop.ts:5`); change `SchedulerOptions.dispatcher` from `SchedulerDispatcher | TurnDispatcher` to `SchedulerDispatcher` (`loop.ts:93`). Covers: `Turn serialization lives in the orchestration layer` (scheduler imports from orchestration, not tg).
- [x] Verify `src/index.ts:23` still compiles passing the concrete dispatcher (now typed as `SchedulerDispatcher`); no runtime change.
- [x] Run `bun test src/scheduler/loop.test.ts` and `bun run typecheck`. The `makeFakeDispatcher` fake is unchanged.

Commit: `phase 2: decouple scheduler from telegram layer`

## Phase 3: Boundary check and validation

- [x] Grep for any remaining `from.*tg/turn-dispatcher` imports across `src/` and update stragglers.
- [x] Grep for any remaining direct `.runners.get(` or `.runners.` reads outside `orchestration/dispatcher.ts`; confirm there are none.
- [x] Confirm no module under `src/scheduler/` imports anything from `src/tg/` (the cross-layer leak is closed).
- [x] Update affected tests (`src/tg/intake.test.ts` and any test importing `TurnDispatcher`). NOTE: `intake.test.ts` had one `.runners.has(...)` assertion — replaced with `hasRunner(...)`. No test imported `TurnDispatcher` from the old path directly (tests exercise it via `createTelegramIntake`).
- [x] Run full validation: `litespec validate turn-dispatcher-relocation`, `bun test`, `bun run typecheck`.

Commit: `phase 3: finalize dispatcher relocation boundary`

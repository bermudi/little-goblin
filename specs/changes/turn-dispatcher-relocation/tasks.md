# Tasks

## Phase 1: Relocate the dispatcher and encapsulate the runners map

- [ ] Create `src/orchestration/dispatcher.ts` by moving `TurnDispatcher` from `src/tg/turn-dispatcher.ts`. Make `runners` private. Add `getRunner(sessionId): AgentRunner | null` returning the current runner or null. Remove the internal `new MessageBuffer(...)` fallback at `turn-dispatcher.ts:135`; `createMessageBuffer` always delegates to `createMessageBufferFn`, which becomes mandatory at construction. Covers: `Turn serialization lives in the orchestration layer`, `Turn dispatcher runners map is encapsulated`.
- [ ] Delete `src/tg/turn-dispatcher.ts` (no re-export shim).
- [ ] Update `src/tg/intake.ts`: import `TurnDispatcher` from `../orchestration/dispatcher.ts`; construct the dispatcher with a `createMessageBuffer` factory containing the `MessageBuffer` construction logic that previously lived in the dispatcher (`turn-dispatcher.ts:132-144`, including the `onTopicNotFound` orphan-archive hook). Replace `dispatcher.runners.get(session.id)` at `intake.ts:274, 381` with `dispatcher.getRunner(session.id)`. Covers: `Turn serialization lives in the orchestration layer` (intake injects factory), `Turn dispatcher runners map is encapsulated`.
- [ ] Update `src/bot.ts` (`bot.ts:21`) and `src/index.ts` imports of `TurnDispatcher` to the new path.
- [ ] Run `bun run typecheck` and fix all broken import paths.

Commit: `phase 1: relocate TurnDispatcher to orchestration`

## Phase 2: Decouple the scheduler from the Telegram layer

- [ ] Update `src/scheduler/loop.ts`: delete `import type { TurnDispatcher } from "../tg/turn-dispatcher.ts"` (`loop.ts:5`); change `SchedulerOptions.dispatcher` from `SchedulerDispatcher | TurnDispatcher` to `SchedulerDispatcher` (`loop.ts:93`). Covers: `Turn serialization lives in the orchestration layer` (scheduler imports from orchestration, not tg).
- [ ] Verify `src/index.ts:23` still compiles passing the concrete dispatcher (now typed as `SchedulerDispatcher`); no runtime change.
- [ ] Run `bun test src/scheduler/loop.test.ts` and `bun run typecheck`. The `makeFakeDispatcher` fake is unchanged.

Commit: `phase 2: decouple scheduler from telegram layer`

## Phase 3: Boundary check and validation

- [ ] Grep for any remaining `from.*tg/turn-dispatcher` imports across `src/` and update stragglers.
- [ ] Grep for any remaining direct `.runners.get(` or `.runners.` reads outside `orchestration/dispatcher.ts`; confirm there are none.
- [ ] Confirm no module under `src/scheduler/` imports anything from `src/tg/` (the cross-layer leak is closed).
- [ ] Update affected tests (`src/tg/intake.test.ts` and any test importing `TurnDispatcher`).
- [ ] Run full validation: `litespec validate turn-dispatcher-relocation`, `bun test`, `bun run typecheck`.

Commit: `phase 3: finalize dispatcher relocation boundary`

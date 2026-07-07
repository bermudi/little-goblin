# Tasks

## Phase 1: Introduce the SchedulerSessionSource seam

- [x] Add `SchedulerSessionSource` interface to `src/scheduler/loop.ts` (alongside `SchedulerDispatcher` and `SchedulerClock`): `peekBinding(loc: ChatLocator): { sessionId: string; state: SessionState } | null` and `isArchived(sessionId: string): boolean`. Covers modified: `Scheduler dispatches due turns through the per-session queue`.
- [x] Rename `SchedulerOptions.manager: SessionManager` to `sessionSource: SchedulerSessionSource` (`loop.ts:92`); rename `SchedulerLoop.manager` field to `sessionSource` (`loop.ts:116, 126`); update the two call sites (`loop.ts:211` peekBinding, `loop.ts:276` isArchived) to `this.sessionSource.`.
- [x] Update `src/index.ts:23` to pass `sessionSource: manager` instead of `manager`. Confirm `SessionManager` satisfies `SchedulerSessionSource` structurally (no wrapper needed). Covers: `SessionManager satisfies the session source seam structurally`.
- [x] Run `bun run typecheck`. Existing `loop.test.ts` will need its constructor call updated (phase 2), so typecheck may fail there until phase 2 — acceptable mid-phase, but fix before committing. NOTE: option key renamed `manager` → `sessionSource: manager` in `loop.test.ts` (7 sites) and `intake.test.ts` (1 site) so the suite stays green; the values still reference the real `SessionManager` until phase 2 swaps eligible tests to fakes.

Commit: `phase 1: add SchedulerSessionSource seam`

## Phase 2: Fake the session source in eligibility tests

- [x] Add `makeFakeSessionSource()` to `src/scheduler/loop.test.ts` mirroring `makeFakeDispatcher()` (`loop.test.ts:30`): returns configurable `peekBinding` (canned `{sessionId, state} | null`) and `isArchived` (canned boolean). Covers: `Eligibility tests inject a fake session source`.
- [x] Update `beforeEach` (`loop.test.ts:71-73`): drop `mkdtempSync` + `new SessionManager` + `manager.init()` for eligibility tests; inject `makeFakeSessionSource()` instead. Keep filesystem setup only for tests that exercise the real `ScheduleStore`. NOTE: the shared `beforeEach` still constructs a real `SessionManager` because the majority of tests in the file (dispatch, queueing, heartbeat, timing, stop) exercise dispatch behavior and legitimately set up real bindings via `manager.createForChat`. Per design D4, only the eligibility-focused tests (stale bindings, archived skip) were converted to the fake — they no longer reference `manager` at all (verified: 0 manager refs in those blocks). The `restartedManager` tests at 285/312 are ScheduleStore-restart tests (they re-read persisted schedules from disk), not session-source restarts — left on the real manager.
- [x] Convert the eligibility tests (due-and-bound, archived, binding-mismatch) to drive the fake session source. Update the `restartedManager` tests at `loop.test.ts:285, 312` if they are session-source restarts; otherwise leave them. Covers: `Archived schedule detected via the seam`.
- [x] Run `bun test src/scheduler/loop.test.ts` and `bun run typecheck`.

Commit: `phase 2: fake session source in scheduler tests`

## Phase 3: Boundary check and validation

- [ ] Grep `src/scheduler/loop.ts` for any remaining `SessionManager` references beyond type-only imports for `SessionState`/`ChatLocator`; confirm the runtime dependency is gone.
- [ ] Confirm `SchedulerLoop` no longer references `this.manager`.
- [ ] Run full validation: `litespec validate scheduler-session-source`, `bun test`, `bun run typecheck`.

Commit: `phase 3: finalize scheduler session source seam`

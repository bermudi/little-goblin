# Cascade Cancel — Tasks

## Phase 1: `cancelBySession` method on `SubagentRunner`

- [x] Add a parent-status guard to the start of `spawn()` in `src/subagents/runner.ts`: if `options.spawnedBy` is present and matches an id in `this.activeSubagents`, and the parent instance's status is not `running`, throw an error. This prevents a cancelled/completed subagent from spawning new children during `cancelBySession` cleanup. Add tests in `src/subagents/test/guards.suite.ts` or `lifecycle.suite.ts` for rejected child-of-cancelled and child-of-completed spawns, and allowed child-of-running spawn.
- [x] Add `cancelBySession(sessionId: string): Promise<void>` to `src/subagents/runner.ts`, placed after the existing `cancel(id)` method. Implement the three-phase pattern from design D1/D5: (1) synchronous BFS tree walk collecting all descendants of the session by parentage (`spawnedBy`), regardless of parent status, skipping null `spawnedBy`; (2) synchronous marking — set `status = "cancelled"` on every collected non-terminal instance; (3) async cleanup in BFS order — for each marked instance, run each step in its own try/catch: `session.abort()` (swallow errors), `persistMetaPatch({ status: "cancelled", completedAt: new Date().toISOString() })` (log errors), `instance.unsubscribe()` and set `instance.unsubscribe = null` (swallow errors; ensure nulling even if `unsubscribe()` throws), then `teardownInstance(instance)` (log errors). Per design D2, `cancelBySession` resolves after all instances are attempted and never rejects. Log the cancelled count at debug level with the stable message `cascade-cancel: subagents cancelled` and fields `{ count, sessionId }`.
- [x] Add tests in `src/subagents/test/lifecycle.suite.ts` under `describe("SubagentRunner.cancelBySession", ...)`: direct children cancelled, recursive cascade cancels grandchildren, terminal parent with running child is still cancelled, terminal instances skipped, null spawnedBy not matched, no subagents for session is a no-op, other sessions not affected, double-cancel safety (concurrent `cancelBySession` + `cancel` — abort called exactly once). Use `spawnedBy` option on `runner.spawn()` to create the tree.
- [x] Run `bun test src/subagents/mod.test.ts` — all subagent tests pass.
- [x] Commit: `phase 1: cancelBySession method on SubagentRunner`

## Phase 2: Wire cascade into `disposeRunner` and make it async

- [ ] Change `disposeRunner` to `async disposeRunner(sessionId: string): Promise<void>` in `src/orchestration/dispatcher.ts`. Add `await this.subagentRunner.cancelBySession(sessionId)` as the first line of the method body, before `this.promptQueues.delete(sessionId)`. Because `cancelBySession` never rejects, no try/catch is needed; runner disposal happens after the cascade.
- [ ] Make `applySideEffects` async in `src/tg/intake.ts`: change its return type to `Promise<void>`, add `await` before `dispatcher.disposeRunner(effect.sessionId)` in the `runner-disposed` branch, and add `await` at the two `handleText` call sites. This preserves the existing sequential side-effect processing: `runner-created` (e.g. from `/new` or `/resume`) will not run until `disposeRunner` has finished cancelling the old session's subagents.
- [ ] Update the `disposeRunner` call in `src/tg/intake.test.ts` — add `await`.
- [ ] Grep for all `disposeRunner` calls in `src/` and `test/` and verify every call site is awaited after the signature change is made. Update any non-awaited call sites to `await`.
- [ ] Grep for all `applySideEffects` calls in `src/` and `test/` and verify every call site is awaited after the signature change is made. `applySideEffects` returning `Promise<void>` must not be ignored or the `runner-disposed`/`runner-created` ordering guarantee breaks.
- [ ] Add a code-level comment or JSDoc to `cancelPending` in `src/orchestration/dispatcher.ts` explicitly stating that it aborts only the queued prompt and does not cascade to subagents (proposal non-goal and design D4).
- [ ] Add a test verifying `disposeRunner` calls `cancelBySession` — either in `intake.test.ts` (spy on the `SubagentRunner` method) or in a dispatcher-focused test. Verify subagents are cancelled before the runner is disposed.
- [ ] Run `bun test` — all tests pass.
- [ ] Commit: `cascade-cancel: wire cascade into disposeRunner`

## Phase 3: Verify and finalize

- [ ] Run `bun test` — full suite green.
- [ ] Run `bun tsc --noEmit` — no TypeScript errors from the async signature change.
- [ ] Verify no new `console.log` calls, no `any` types, no `$GOBLIN_HOME` access outside approved modules.
- [ ] Commit: `cascade-cancel: verify full suite and finalize`

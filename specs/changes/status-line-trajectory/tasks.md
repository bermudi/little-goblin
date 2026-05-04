# Tasks: Status line trajectory

## Phase 1: Replace phase machine with per-tool slot model

Rewrites `MessageBuffer`'s status state from `phase + toolsObserved + toolsRunning + hadError` to an ordered `Map<string, ToolSlot>` where each slot tracks `runningCount`, `completedCount`, `startedAt`, `endedAt?`, and `everErrored`. Implements the multi-line render: header `"🤔 thinking…"` + one slot line per visible tool, in observation order, with folding by name, parallel-invocation handling, and sticky-error semantics. No cap, no timing — those land in later phases. Visibility filtering, throttle, in-flight coalescing, eager placeholder, status-frozen, chat-action all stay structurally identical.

Touches: [src/tg/buffer.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.ts), [src/tg/buffer.test.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.test.ts), [src/tg/mod.ts](file:///home/daniel/build/little-goblin/src/tg/mod.ts).

- [x] Add `ToolSlot` interface in `src/tg/buffer.ts`: `{ runningCount: number; completedCount: number; startedAt: number; endedAt?: number; everErrored: boolean }`. Export it for tests and barrel re-export.
- [x] Remove fields `phase`, `toolsObserved`, `toolsRunning`, `hadError` from the `MessageBuffer` class. Remove the `StatusPhase` type export.
- [x] Add field `private slots: Map<string, ToolSlot> = new Map()`.
- [x] Update [src/tg/mod.ts](file:///home/daniel/build/little-goblin/src/tg/mod.ts): replace `export type { MessageBufferOptions, StatusPhase } from "./buffer.ts";` with `export type { MessageBufferOptions, ToolSlot } from "./buffer.ts";`.
- [x] Rewrite `buildStatusLine()` per the **Status renders per-tool slots in observation order** spec requirement: returns `""` if visibility is `"none"` or if `!placeholderSent && slots.size === 0`; else returns `"🤔 thinking…"` joined with one line per slot. Effective state per slot: `runningCount > 0 → running`, else `everErrored → err`, else `ok`. Slot render: `"<icon> <name>[ ×<count>]"` where icon is `"🔧" / "✅" / "❌"` per effective state, count = `runningCount + completedCount`, suffix only when count > 1.
- [x] Update `onToolStart(name, _input)`: **response flush first** — `flushResponse(true)` if `accumulatedText.length > 0`, before the visibility filter. The response message is user-visible answer text and must be fully landed before the tool blocks the event loop. This is a pre-existing invariant the rewrite must preserve (see commit `fix: force-flush response text on onToolStart before tool blocks`). Then: keep the `shouldShowTool` filter; on first observation create slot `{ runningCount: 1, completedCount: 0, startedAt: now(), endedAt: undefined, everErrored: false }`; on re-entry increment `runningCount`, set `startedAt = now()`, clear `endedAt`. Always call `commitStatus()`.
- [x] Update `onToolEnd(name, isError)`: keep the filter; look up the slot (must exist); decrement `runningCount`, increment `completedCount`, set `endedAt = now()`; if `isError` set `everErrored = true`. Call `commitStatus()`.
- [x] Update `onTextDelta(delta)`: remove the `phase === "working" && toolsRunning.size === 0` Working→Done block (per design **D7**). Keep delta accumulation, lazy placeholder, chat-action start, and `flushResponse`.
- [x] Update `onAgentEnd()`: remove the `this.phase = "done"` line; keep force flush, `statusFrozen = true`, response force flush, chat-action stop.
- [x] Update `_state()`: drop removed scalars; expose `slots` as a serializable structure (e.g. `Array.from(this.slots.entries())`).
- [x] Rewrite `src/tg/buffer.test.ts` assertions that depend on the old single-line render: replace assertions on `"🔧 working: <names>"` and `"✅ <names>"` with multi-line `"🤔 thinking…\n<icon> <name>"` assertions.
- [x] Delete tests that exercise the removed phase machine: working→done on first text delta, sequential-tool re-enter Working, "many tools collapse to one Working edit" (replace with the **Many sequential tools coalesce via throttle** scenario asserting a strict `< 2T + 2 = 10` write count).
- [x] Add tests covering the new per-tool spec scenarios: header persists, single tool through running→ok, multiple tools each get a line in observation order, repeat invocations fold to `×N`, re-entry from `ok` increments count, parallel invocations stay in `running` until `runningCount` hits zero, mixed success/error sticks to `err`, filtered tool produces no slot, zero-tool turn rests on header (placeholder sent path), zero-tool turn with no placeholder sends nothing.
- [x] Run `bun test src/tg/buffer.test.ts` and confirm all tests pass.
- [x] Run `bun run tsc --noEmit` (or the project's typecheck command) and confirm clean — catches any drift in the `src/tg/mod.ts` re-exports or other consumers.
- [x] Commit: `phase 1: replace status phase machine with per-tool slot model`.

## Phase 2: Cap per visibility level with overflow footer

Adds the per-level slot cap and the `"… +N earlier"` footer when the cap is exceeded. Oldest completed slots are elided first; running slots are exempt. Adds the `VISIBILITY_LIMITS` table.

Touches: [src/tg/buffer.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.ts), [src/tg/buffer.test.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.test.ts).

- [x] Add and export `VISIBILITY_LIMITS: Record<string, { cap: number; timing: boolean }>` in `src/tg/buffer.ts` with values: `none {0,false}`, `minimal {8,false}`, `standard {12,false}`, `verbose {20,true}`, `debug {25,true}`. The `timing` flag is unused this phase; phase 3 reads it.
- [x] Add a small helper that resolves the active level's limits, falling back to `DEFAULT_VISIBILITY` for unknown levels (mirrors `shouldShowTool`).
- [x] Extend `buildStatusLine()` cap logic per **Status line caps oldest completed slots**: walk slots in insertion order; while `slots.size - elidedCount > cap`, elide the next slot whose effective state is `ok` or `err` (running slots are skipped during elision counting); render the kept slots; append `"… +<N> earlier"` footer when `elidedCount > 0`.
- [x] Add a unit test that asserts every key in `VISIBILITY_TOOLS` has a matching entry in `VISIBILITY_LIMITS` (parity guard, per design **D5** and the spec's build-error clause in **Tool visibility config filters status display**).
- [x] Add tests for the cap scenarios: under-cap renders all slots without footer; standard with 15 distinct completed tools renders 12 most recent + `"… +3 earlier"`; running slots beyond the cap still render and only completed slots count toward elision; multi-running scenario (8 running + 8 completed at cap 12) renders all 8 running plus 4 most-recent completed plus `"… +4 earlier"`.
- [x] Run `bun test src/tg/buffer.test.ts` and confirm all tests pass.
- [x] Run `bun run tsc --noEmit` and confirm clean.
- [x] Commit: `phase 2: cap status slots per visibility level with overflow footer`.

## Phase 3: Per-tool elapsed time for verbose and debug

Renders `(N.Ns)` after each completed slot when the active visibility level has `timing: true`. Running slots and lower visibility levels remain unaffected. Per design **D6**, when a slot has multiple invocations the suffix measures the most recent invocation only (cumulative timing is intentionally out of scope; the journal in `events.jsonl` retains per-call durations).

Touches: [src/tg/buffer.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.ts), [src/tg/buffer.test.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.test.ts).

- [x] Extend `buildStatusLine()` slot render branch: when the active level's `timing` flag is true AND the slot's effective state is `"ok"` or `"err"` AND `endedAt` is defined, append `" (<seconds>s)"` where seconds = `((endedAt - startedAt) / 1000).toFixed(1)`.
- [x] Confirm `now: () => number` is used everywhere we set `startedAt` / `endedAt` so timing stays deterministic in tests (the constructor already injects this).
- [x] Add tests for the timing scenarios: verbose renders `"✅ bash (2.1s)"`; standard renders `"✅ bash"` with no suffix; running slot under verbose renders `"🔧 bash"` with no suffix; debug behaves like verbose; re-entered slot's timing reflects the most recent invocation only.
- [x] Run `bun test src/tg/buffer.test.ts` and confirm all tests pass.
- [x] Run `bun test` (full suite) and confirm no other test regressed.
- [x] Run `bun run tsc --noEmit` and confirm clean.
- [x] Commit: `phase 3: render per-tool elapsed time at verbose and debug visibility`.

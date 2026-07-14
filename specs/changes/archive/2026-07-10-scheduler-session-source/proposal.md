# Scheduler Session Source

## Motivation

`SchedulerLoop` (`src/scheduler/loop.ts`) owns due-turn semantics but depends on the concrete `SessionManager`. The import is type-only (`loop.ts:4`: `import type { ChatLocator, SessionManager, SessionState }`), but the field is typed as the concrete `SessionManager` class (`loop.ts:92, 116`) and the loop calls concrete methods: `this.manager.peekBinding(...)` (`loop.ts:211`) and `this.manager.isArchived(...)` (`loop.ts:276`).

Consequence: scheduler eligibility tests need full filesystem-backed sessions. `loop.test.ts:71-73` does `mkdtempSync(tmpdir())` + `new SessionManager(makeTestConfig(tmpDir))` + `manager.init()` in `beforeEach` for every test. There is no way to test "is this schedule due and eligible?" without spinning up a real session tree.

The dispatcher side already has a seam — `SchedulerDispatcher` (`loop.ts:81-88`) is exercised with a fake (`makeFakeDispatcher`) throughout `loop.test.ts`. Only the session-source side lacks an adapter, so the loop is half-abstracted: dispatcher-fakeable, session-real.

## Scope

Affected capabilities: `orchestration` (scheduler semantics live in the orchestration canon, introduced by the archived `scheduled-turns` change — `Scheduler dispatches due turns through the per-session queue` and `Scheduler lifecycle follows bot lifecycle`) and `sessions`.

This change introduces:

- A scheduler-owned `SchedulerSessionSource` seam: the minimal method surface the loop actually needs from sessions — `peekBinding(locator)` and `isArchived(sessionId)` — lifted into an interface that `SessionManager` satisfies.
- `SchedulerLoop` accepts `SchedulerSessionSource` instead of the concrete `SessionManager`. Production wires `SessionManager` as the adapter; tests inject a fake session source and drop the `mkdtempSync` + `SessionManager.init()` setup.
- The existing `SchedulerDispatcher` seam is left as-is (it already works). This change closes only the session-source half of the abstraction.

## Non-Goals

- No change to due-turn semantics, polling cadence, claim-one-at-a-time behavior, or schedule persistence.
- No change to `SessionManager`'s public surface — it just gains `SchedulerSessionSource` as an explicit interface it already structurally satisfies.
- No change to the dispatcher seam (`SchedulerDispatcher` is unchanged).
- No multi-process scheduler, no distributed locking (those remain backlog).
- Not extracting a `SchedulerClock`/`SchedulerTimer` seam — only the session-source seam is in scope; the dispatcher and clock seams already exist.
- Not retroactively backfilling scheduler canon. The scheduler requirements already live in the `orchestration` capability spec (folded in by the archived `scheduled-turns` change); this change adds a seam to the existing `Scheduler dispatches due turns through the per-session queue` requirement rather than minting a new capability.

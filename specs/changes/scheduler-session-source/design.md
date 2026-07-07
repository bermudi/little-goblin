# Scheduler Session Source Design

## Architecture

`SchedulerLoop` (`src/scheduler/loop.ts`) owns due-turn semantics but depends on the concrete `SessionManager`. The dispatcher and clock already have seams (`SchedulerDispatcher`, `SchedulerClock`); sessions is the last concrete dependency.

```
╭──────────────╮   manager: SessionManager (concrete)   ╭──────────────────╮
│ SchedulerLoop│───────────────────────────────────────▶│ SessionManager   │
│              │   dispatcher: SchedulerDispatcher       │ (filesystem)     │
│              │───────────────────────────────────────▶│                  │
│              │   clock: SchedulerClock                 ╰──────────────────╯
╰──────────────╯                                     ▲
                                                     │ tests need real FS:
╭──────────────────────╮                             │ mkdtempSync + init()
│ loop.test.ts         │── new SessionManager(tmp) ───┘
╰──────────────────────╯
```

After this change a scheduler-owned `SchedulerSessionSource` seam sits between the loop and sessions:

```
╭──────────────╮   sessionSource: SchedulerSessionSource   ╭──────────────────╮
│ SchedulerLoop│──────────────────────────────────────────▶│ SchedulerSession │ (interface)
│              │   dispatcher: SchedulerDispatcher          │  peekBinding     │
│              │   clock: SchedulerClock                    │  isArchived      │
╰──────────────╯                                             ╰────────┬─────────╯
                                                                      │ adapter
╭──────────────────────╮                                             ▼
│ loop.test.ts         │── makeFakeSessionSource() ──╮    ╭──────────────────╮
│ (no FS for sessions) │                            └───▶│ fake (canned)    │
╰──────────────────────╮                                  ╰──────────────────╯
                       │             production ─────────▶╭──────────────────╮
                       └──────────── index.ts passes ────▶│ SessionManager   │
                                     the real manager     ╰──────────────────╯
```

### The two methods the loop actually needs

Verification of `loop.ts` shows exactly two `SessionManager` calls:
- `this.manager.peekBinding(schedule.locator)` (`loop.ts:211`) — non-mutating binding check.
- `this.manager.isArchived(sessionId)` (`loop.ts:276`, via private `isArchived` wrapper) — archived-session check.

`peekBinding` returns `{ sessionId: string; state: SessionState } | null`; `isArchived` returns `boolean`. Both already exist on `SessionManager` (`manager.ts:355, 107`), so `SessionManager` satisfies the seam structurally with no adapter wrapper.

## Decisions

### D1. `SchedulerSessionSource` interface in `src/scheduler/loop.ts`

**Chosen:** define the interface alongside `SchedulerDispatcher` and `SchedulerClock` in `src/scheduler/loop.ts`:

```ts
export interface SchedulerSessionSource {
  peekBinding(loc: ChatLocator): { sessionId: string; state: SessionState } | null;
  isArchived(sessionId: string): boolean;
}
```

**Why:** all three scheduler seams live together in `loop.ts`. The dispatcher and clock are already there; the session source joins them. Keeping it out of `src/sessions/` avoids the sessions layer knowing about scheduler concerns.

Specs: `Scheduler dispatches due turns through the per-session queue` (the seam clause).

### D2. `SchedulerOptions.manager` becomes `sessionSource: SchedulerSessionSource`

**Chosen:** rename the option and narrow the type. `SchedulerLoop.manager` (`loop.ts:116`) becomes `private readonly sessionSource: SchedulerSessionSource`. The two call sites (`:211`, `:276`) change from `this.manager.` to `this.sessionSource.`.

**Why:** the loop does not use any other `SessionManager` method. Narrowing the type makes the dependency explicit and lets tests fake it.

**Constraint:** the private `isArchived` wrapper method on the loop (`loop.ts:271-277`) can stay as a thin delegate or inline; either way it calls `this.sessionSource.isArchived`.

Specs: `Scheduler dispatches due turns through the per-session queue`.

### D3. `SessionManager` satisfies the seam structurally — no wrapper

**Chosen:** production passes the real `SessionManager` instance directly as `sessionSource`. No adapter class.

**Why:** `SessionManager` already has `peekBinding(loc, opts?)` (`manager.ts:355`) and `isArchived(sessionId)` (`manager.ts:107`). TypeScript structural typing: a method `(loc, opts?)` is assignable to an interface requiring `(loc)` — fewer/optional parameters satisfy a narrower signature. So `SessionManager` is assignable to `SchedulerSessionSource` without `implements`. Verified against the actual signatures during planning, not assumed.

**Deliberate narrowing — `isGuest` is omitted from the seam:** `SessionManager.peekBinding` accepts an optional `opts?: { isGuest?: boolean }`. The `SchedulerSessionSource.peekBinding` signature omits this parameter entirely. This is intentional, not an oversight: the scheduler never passes `isGuest` (no scheduled turns for guest sessions — per the `telegram-guest-mode` design, the scheduler does not pass `isGuest` and so never touches the guest map). Omitting it from the seam makes the scheduler's session-source dependency strictly narrower than `SessionManager`'s full surface, which is the point of the seam. If scheduled guest turns ever become a feature, the seam widens at that time.

**Rejected:** an explicit adapter wrapper (`new SchedulerSessionSourceAdapter(manager)`). It would add a class with no behavior — pure indirection. Structural satisfaction is the TypeScript idiom.

Specs: `SessionManager satisfies the session source seam structurally`.

### D4. Tests drop the filesystem setup for eligibility cases

**Chosen:** add a `makeFakeSessionSource()` helper to `loop.test.ts` mirroring `makeFakeDispatcher()` (`loop.test.ts:30-43`). It returns canned `{ sessionId, state } | null` for `peekBinding` and `boolean` for `isArchived`. Eligibility tests (due-and-bound, archived, binding-mismatch) switch to the fake and delete their `mkdtempSync`/`SessionManager.init()` setup.

**Constraint:** tests that exercise the *schedule store* (persistence, claim-one-at-a-time) still need the real `ScheduleStore`, which may still touch the filesystem — that is a different dependency and is not in scope. Only the session-side setup is removed. Tests that genuinely need a real `SessionManager` (e.g. integration-style) may keep it; the fake is for eligibility-focused unit tests.

Specs: `Eligibility tests inject a fake session source`.

## File Changes

### `src/scheduler/loop.ts` (modified)

- Add `SchedulerSessionSource` interface (peekBinding + isArchived).
- `SchedulerOptions.manager: SessionManager` → `sessionSource: SchedulerSessionSource` (`loop.ts:92`).
- `SchedulerLoop.manager` field → `sessionSource` (`loop.ts:116, 126`).
- `this.manager.peekBinding(...)` (`loop.ts:211`) → `this.sessionSource.peekBinding(...)`.
- `this.manager.isArchived(...)` (via `loop.ts:276`) → `this.sessionSource.isArchived(...)`.
- Delete `import type { ... SessionManager ... }` from `../sessions/mod.ts` (`loop.ts:4`) if `SessionManager` is no longer referenced (it may still be imported for `SessionState`/`ChatLocator` types — keep those).

Covers modified `Scheduler dispatches due turns through the per-session queue`.

### `src/index.ts` (modified)

- `new SchedulerLoop({ store, manager, dispatcher, home })` (`index.ts:23`) → `new SchedulerLoop({ store, sessionSource: manager, dispatcher, home })`. The same `manager` instance is passed; only the option name changes.

Covers `SessionManager satisfies the session source seam structurally`.

### `src/scheduler/loop.test.ts` (modified)

- Add `makeFakeSessionSource()` helper returning an object with configurable `peekBinding`/`isArchived` behavior.
- Eligibility tests (due-and-bound, archived, binding-mismatch) switch from `new SessionManager(makeTestConfig(tmpDir))` + `manager.init()` (`loop.test.ts:72-73`) to the fake session source.
- Tests that need real schedule-store persistence keep their filesystem setup for the store; only session-side setup is removed where the test doesn't exercise it.
- Some tests at `loop.test.ts:285, 312` construct `restartedManager` — these may be session-source restarts (verify during build) and switch to fake restarts.

Covers `Eligibility tests inject a fake session source`, `Archived schedule detected via the seam`.

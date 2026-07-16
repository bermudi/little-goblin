# Cascade Cancel — Design

## Architecture

The change bridges two existing modules:

- **`SubagentRunner`** (`src/subagents/runner.ts`) — owns the in-memory
  `activeSubagents: Map<id, SubagentInstance>` and the lifecycle methods
  (`spawn`, `cancel`, `dispose`, `list`).
- **`TurnDispatcher`** (`src/orchestration/dispatcher.ts`) — owns the per-session
  `AgentRunner` map, prompt queues, and the `SubagentRunner` instance held in
  `this.subagentRunner`.

Today, `disposeRunner(sessionId)` disposes the `AgentRunner` but never consults
`subagentRunner`. The fix adds a scoped cancel method to `SubagentRunner` and
wires it into `disposeRunner`.

### Data flow

```
Command (/new, /resume, /archive, /project)
  → side effect: runner-disposed
  → intake.applySideEffects (now async)
  → await dispatcher.disposeRunner(sessionId)   [now async]
  → dispose the AgentRunner, delete from map, clear prompt queue    [existing]
  → subagentRunner.cancelBySession(sessionId)   [new]
  → walk spawnedBy tree, mark all running children cancelled synchronously
  → abort sessions, persist meta, teardown      [async, awaited]
```

### The spawn tree

`SubagentInstance.spawnedBy` records the spawner's identity:

- **Top-level subagent**: `spawnedBy === <goblin session id>` (set by the
  `spawn_subagent` tool in `src/subagents/tool.ts`).
- **Nested subagent**: `spawnedBy === <parent subagent id>` (the tool factory
  passes the subagent's own id as `sessionId` for its children).
- **Legacy meta**: `spawnedBy === null` (predates the field).

The tree is reconstructable from the in-memory `activeSubagents` map by
following `spawnedBy` links. No on-disk traversal is needed — cascade cancel
operates on live (in-memory) instances only. When `pruneTerminal()` removes a
terminal parent, running descendants whose `spawnedBy` points to the pruned
parent can no longer resolve ancestry through `activeSubagents` alone. To
preserve cascade correctness, `cancelBySession` SHALL resolve ancestry using
retained terminal ancestors (deferred pruning until all descendants are
terminal), a parent/session index that maps pruned parents to their session,
or equivalent recovery logic. `pruneTerminal()` SHALL not remove a terminal
instance while it has running descendants in the same spawn tree.

## Decisions

### D1: `cancelBySession` marks all targets synchronously before any await

**Chosen:** Walk the tree, collect all descendants in the session's spawn tree,
set `instance.status = "cancelled"` on every non-terminal one synchronously,
then clean up all marked instances concurrently (starting all aborts in parallel
so a parent that is blocked on a child result can be unblocked when the child's
abort settles).

**Why over cancel-one-by-one:** `cancel(id)` already checks
`instance.status !== "running"` and returns early (without calling
`session.abort()`) if the instance is terminal. This same pattern is applied to
the whole tree: mark every non-terminal instance `cancelled` synchronously
before any `await` so a concurrent `cancel(id)` call sees the cancelled status
and exits as a no-op. Marking the full tree first closes the window entirely —
every targeted instance is non-running before any `await` fires.

**Constraint:** The collection and marking phases are both synchronous (no
awaits between them). The cleanup phase is asynchronous.

### D2: `cancelBySession` error handling is per-instance and never rejects

**Chosen:** Each cleanup step for each instance is individually wrapped in
its own error handling: `session.abort()` errors are swallowed, `persistMetaPatch`
errors are logged, `instance.unsubscribe()` errors are swallowed and
`instance.unsubscribe` is set to `null` in a `finally` (or equivalent catch), and
`teardownInstance` errors are logged. No single step's failure stops the
remaining steps for that instance, and no single instance's failure stops the
loop for the other instances. `cancelBySession` resolves after all instances
have been attempted. Any instance that is already terminal when cleanup reaches
it is skipped (the synchronous marking already made it non-running).

**Why:** This matches the resilience of `cancel(id)`, which catches each stage
individually. The cascade change chose per-instance error handling because a
single subagent in a bad session state should not block the dispatcher from
disposing the session or the runner from continuing. Because `cancelBySession`
never rejects, `disposeRunner` can await it without needing a try/catch to
guarantee runner disposal.

### D3: `disposeRunner` becomes async and awaits the cascade

**Chosen:** `disposeRunner(sessionId): Promise<void>` — callers await it.

**Why over fire-and-forget:** `disposeRunner` is called from two places:
`applySideEffects` in `src/tg/intake.ts` and a test in `src/tg/intake.test.ts`.
`applySideEffects` itself is awaited at two call sites inside `handleText` in
`src/tg/intake.ts`, and those call sites are already in `async` functions that
use `await`. Making `applySideEffects` async is a small change (add `async` to
the function declaration and `await` at the two `handleText` call sites plus the
`disposeRunner` call inside `applySideEffects`).

Fire-and-forget would mean a `runner-created` side effect (from `/new` or
`/resume`) could create a new runner while the old session's subagents are
still running. The subagents would then resolve into a disposed context,
producing the exact orphaned-work bug we're fixing — just with a shorter
window.

**Constraint:** `applySideEffects` becomes `async function applySideEffects:
Promise<void>`. The two call sites add `await`. The test in `intake.test.ts`
adds `await`.

### D4: `cancelPending` does not cascade

**Chosen:** `cancelPending(sessionId)` aborts only the queued prompt. It does
not call `cancelBySession`.

**Why:** `cancelPending` is called when a user sends `/cancel` to abort a
queued prompt. The session is still alive — the user may want to keep talking
to goblin, and goblin's subagents may still be doing useful work. Cascading
here would kill subagents the user still wants. Only `disposeRunner` (session
swap via `/new`, `/resume`, `/archive`, `/project`) cascades, because the old
session is going away permanently.

### D5: Tree walk is BFS from the session id

**Chosen:** Start with all instances where `spawnedBy === sessionId`. For each
match, find children where `spawnedBy === match.id`, regardless of the parent's
status. Continue until no new descendants are found. Collect all ids into a
flat set. Mark all non-terminal instances in the set synchronously. Clean up all
marked instances concurrently (starting all aborts in parallel so a parent that
is blocked on a child result can be unblocked when the child's abort settles).

**Why over recursive DFS:** BFS is simpler to implement iteratively and avoids
stack-overflow concerns (though depth is capped at 3, so this is academic).
The flat-set approach makes the synchronous marking phase straightforward.

**Why over flat-filter by session id only:** Flat-filtering
`spawnedBy === sessionId` misses grandchildren. The handoff explicitly flags
this as a trap, so the design chose the tree walk to avoid the bug.

**Why parentage, not runtime status:** The cascade is triggered by the session
being disposed, not by a child being cancelled. A running grandchild under a
completed direct child is still part of the session's spawn tree, so the design
chooses to cancel it. Recursion follows `spawnedBy` links, not status transitions.

### D6: No new status type or meta field

**Chosen:** Cascade cancel uses the existing `cancelled` status and the
existing `persistMetaPatch` mechanism. No new `SubagentStatus` variant and no
new `SubagentMeta` field are introduced. `completedAt` is an existing optional
`SubagentMeta` field already written by `cancel(id)` and `dispose()`; the
cascade writes it to match those methods.

**Why:** The cancelled status already means "aborted before completion."
Cascade cancel is semantically identical to `cancel(id)` — just applied to
multiple instances. Adding a new status would complicate the type union and
all status-checking code for no semantic gain.

## File Changes

### `src/subagents/runner.ts` — add parent-status guard to `spawn`

At the start of `spawn()`, after the `disposed` guard and depth check, add a
parent-status guard: if `options.spawnedBy` is present and matches an id in
`this.activeSubagents`, then the referenced parent instance's status MUST be
`running`. If the parent is not in `activeSubagents` (e.g. a goblin session id or
a subagent already pruned), no check is applied. If the parent is present but
its status is `completed`, `error`, or `cancelled`, `spawn()` SHALL throw an
error such as "Cannot spawn subagent from a non-running parent".

This closes the race where a subagent that has been marked `cancelled` by
`cancelBySession` but has not yet been aborted can still execute a
`spawn_subagent` tool call and create a child that would not be part of the
cancelled tree.

### `src/subagents/runner.ts` — add `cancelBySession` method

Add a new public method `cancelBySession(sessionId: string): Promise<void>`
after the existing `cancel(id)` method.

The method:

1. **Collect** (synchronous): BFS-walk `this.activeSubagents` starting from
   all instances where `spawnedBy === sessionId`. For each matched instance,
   find descendants where `spawnedBy === matched.id` regardless of the matched
   instance's status. Accumulate into a `Set` of instance ids. Skip instances
   whose `spawnedBy` is `null`.
2. **Mark** (synchronous): For each collected instance, if its status is
   non-terminal (i.e. `status === "running"`, the only non-terminal status in
   `SubagentStatus`), set `status = "cancelled"`. This prevents double-cancel
   races — any concurrent `cancel(id)` call will see a non-running status and
   exit as a no-op.
3. **Clean up** (async, awaited, concurrent per-instance error handling): Clean
   up all marked instances concurrently, starting all aborts in parallel so a
   parent that is blocked on a child result can be unblocked when the child's
   abort settles. For each marked instance, perform each of the following steps
   in its own try/catch so one failing step does not abort the rest or the
   other instances:
   - call `session.abort()` and swallow any errors;
   - call `persistMetaPatch(...)` with `{ status: "cancelled", completedAt: new Date().toISOString() }` and log any errors;
   - call `instance.unsubscribe()` and set `instance.unsubscribe = null`, swallowing any errors and ensuring the field is nulled even if `unsubscribe()` throws;
   - call `teardownInstance(instance)` and log any errors.
   This is the same cleanup that `cancel(id)` performs for a single instance,
   applied to each member of the collected tree. Like `cancel(id)`,
   `cancelBySession` does not remove the instances from `activeSubagents` —
   `pruneTerminal` removes terminal entries lazily on the next `spawn()`.
4. Log the count of cancelled subagents at debug level using a stable message
   prefix: `log.debug("cascade-cancel: subagents cancelled", { count, sessionId })`.
5. Return a resolved `Promise<void>` even if some per-instance cleanups logged
   errors.

**Spec link:** "Cascade cancel aborts all subagents for a session" (subagents
delta).

### `src/orchestration/dispatcher.ts` — wire cascade into `disposeRunner`

Change `disposeRunner` signature from `void` to `async ... Promise<void>`.
Dispose the AgentRunner, remove it from the cache, and clear the prompt queue
**before** awaiting `this.subagentRunner.cancelBySession(sessionId)`. This makes
the stale runner unreachable from `getOrCreateRunner` before `cancelBySession`
yields, so a concurrent scheduled turn cannot enter a runner that is being
disposed.

Current code:
```ts
disposeRunner(sessionId: string): void {
  this.promptQueues.delete(sessionId);
  const prior = this.runners.get(sessionId);
  if (prior) {
    try {
      prior.dispose();
    } finally {
      this.runners.delete(sessionId);
    }
  } else {
    this.runners.delete(sessionId);
  }
}
```

New code:
```ts
async disposeRunner(sessionId: string): Promise<void> {
  let disposeErr: unknown;
  let disposeFailed = false;
  try {
    const prior = this.runners.get(sessionId);
    if (prior) {
      try {
        prior.dispose();
      } catch (err) {
        disposeErr = err;
        disposeFailed = true;
      } finally {
        this.runners.delete(sessionId);
      }
    } else {
      this.runners.delete(sessionId);
    }
    this.promptQueues.delete(sessionId);
    await this.subagentRunner.cancelBySession(sessionId);
  } finally {
    if (disposeFailed) throw disposeErr;
  }
}
```

A separate `disposeFailed` boolean tracks whether disposal threw, because
`dispose()` could throw a falsy value (e.g. `throw undefined` or `throw null`).
Using `if (disposeErr)` alone would swallow a falsy throw; the boolean
ensures every value is rethrown.

**Spec link:** "Disposing a session runner cancels its subagents"
(orchestration delta).

### `src/tg/intake.ts` — make `applySideEffects` async

Change `applySideEffects` from `void` to `async ... Promise<void>`. Add
`await` before `dispatcher.disposeRunner(...)` inside the
`runner-disposed` branch. Add `await` at the two call sites inside
`handleText`. `applySideEffects` already processes side effects sequentially;
awaiting `disposeRunner` in the `runner-disposed` branch guarantees that a
following `runner-created` side effect does not create a new runner until the
old session's subagents are cancelled.

Current:
```ts
function applySideEffects(sideEffects: SideEffect[], message: TelegramIntakeMessage, locator: ChatLocator): void {
```

New:
```ts
async function applySideEffects(sideEffects: SideEffect[], message: TelegramIntakeMessage, locator: ChatLocator): Promise<void> {
```

And inside the `runner-disposed` branch:
```ts
await dispatcher.disposeRunner(effect.sessionId);
```

And at the two call sites:
```ts
await applySideEffects(result.sideEffects, message, locator);
```

### `src/tg/intake.test.ts` — await `disposeRunner` in test

The test that swaps the runner out before the scheduled turn starts calls
`dispatcher.disposeRunner(session.id)`. Add `await` so the test waits for the
cascade to complete.

### `src/subagents/test/lifecycle.suite.ts` — add cascade cancel tests

Add a new `describe("SubagentRunner.cancelBySession", ...)` block with tests
covering:

1. **Direct children cancelled** — spawn two subagents with
   `spawnedBy: "session-abc"`, call `cancelBySession("session-abc")`, verify
   both are cancelled (status + meta + abort called).
2. **Recursive cascade cancels grandchildren** — spawn A with
   `spawnedBy: "session-abc"`, spawn B with `spawnedBy: A.id`, call
   `cancelBySession("session-abc")`, verify both A and B are cancelled.
3. **Terminal parent with running child is still cancelled** — spawn A with
   `spawnedBy: "session-abc"` while A is still running, spawn B with
   `spawnedBy: A.id` while A is still running, then complete A via
   `agent_end`, call `cancelBySession("session-abc")`, verify A remains
   `completed` and B is cancelled. (Spawning B while A is running, then
   completing A before the cancel, properly exercises the terminal-parent
   traversal scenario.)
4. **Terminal instances skipped** — spawn A with
   `spawnedBy: "session-abc"`, complete it via `agent_end`, call
   `cancelBySession("session-abc")`, verify A remains `completed`.
5. **Null spawnedBy not matched** — spawn A with no `spawnedBy` option (defaults
   to null), call `cancelBySession("session-abc")`, verify A is still running.
6. **No subagents for session is a no-op** — call
   `cancelBySession("session-xyz")` with no matching subagents, verify no
   error.
7. **Other sessions not affected** — spawn A with
   `spawnedBy: "session-abc"`, spawn C with `spawnedBy: "session-def"`, call
   `cancelBySession("session-abc")`, verify C is still running.
8. **Double-cancel safety** — spawn A with `spawnedBy: "session-abc"`, call
   `cancelBySession("session-abc")` and `cancel(A.id)` concurrently
   (`Promise.all`), verify `session.abort()` is called exactly once on A.

All tests use the existing `installStandardPiMock()`, `createTestHome`,
`makeConfig`, `flush`, `sessionHolder`, and `DEFAULT_SCOPE` helpers from
`src/subagents/test/support.ts`. Nested subagents are created by calling
`runner.spawn({ ..., spawnedBy: parentId })`.

### `src/tg/intake.test.ts` — add wiring test

Add a test verifying that `disposeRunner` calls
`subagentRunner.cancelBySession(sessionId)`. Spy on the `SubagentRunner`
method, or create a fake `SubagentRunner` that records the call. Verify the
runner is disposed before the cascade completes.

## Changes

- `cancelBySession(sessionId)` — new method that cancels every subagent in the
  session's spawn tree. This is the actual cascade; it is called by
  `disposeRunner()` (session-scoped) and shares a lower-level cleanup helper
  with `dispose()`. `dispose()` remains nuclear, process-wide cleanup: it does
  NOT directly invoke `cancelBySession(sessionId)` for a specific session.
  Instead, `dispose()` performs its own concurrent cleanup of all active
  instances, while `disposeRunner()` performs the session-scoped cascade via
  `cancelBySession(sessionId)`.
- `dispose()` — unchanged semantically (nuclear, for process shutdown), but now
  cleans up active instances concurrently for faster shutdown; per-instance
  teardown errors are logged.
- `disposeRunner(sessionId)` — now async and disposes the runner, clears the
  prompt queue, and awaits the subagent cascade before returning.
- `spawn()` — rejects a `spawnedBy` that points to a non-running parent
  subagent, preventing new children during cancellation or after termination.

## Non-Changes

- `cancel(id)` — unchanged; cancels only the specific subagent whose id was
  provided. It does not cascade to descendants.
- `cancelPending(sessionId)` — unchanged behavior; it aborts only the queued
  prompt and does not cascade to subagents.
- `SubagentRunner.activeSubagents` — stays private. `cancelBySession` is a
  new public method that accesses it internally.
- `SubagentInstance.spawnedBy` — field is unchanged.
- Meta format — unchanged.
- `pruneTerminal()` — unchanged (still called lazily on `spawn()`).

# Cascade Cancel

## Motivation

When a session is disposed — via `/new`, `/resume`, `/archive`, or `/project` —
`TurnDispatcher.disposeRunner(sessionId)` disposes the session's `AgentRunner`
and severs its prompt-queue chain. But it does **not** cancel subagents spawned
by that session. Those subagents keep running against a session that no longer
exists, producing orphaned work: wasted compute, stale meta on disk, and results
that resolve into a dead context.

This is a latent correctness bug, not a missing feature. The `SubagentRunner`
already has `cancel(id)` (single subagent) and `dispose()` (nuclear — all
subagents, for process shutdown). What's missing is a scoped cancel: abort all
subagents belonging to a specific session, recursively through the spawn tree.

The `spawnedBy` field on `SubagentInstance` (session id for top-level, parent
subagent id for nested) already records the parent-child linkage. The tree is
reconstructable from the in-memory map. The fix is a new method that walks that
tree and a one-line wiring in `disposeRunner`.

## Scope

Affected capabilities: `subagents` and `orchestration`.

This change introduces:

- A new `SubagentRunner.cancelBySession(sessionId)` method that cancels all
  running subagents in the spawn tree rooted at the given session id. The method
  walks the tree by `spawnedBy` parentage — direct children whose `spawnedBy`
  matches the session id, then their descendants whose `spawnedBy` matches any
  collected id, regardless of each parent's status. The method follows the same
  synchronous-status-before-await pattern as `cancel(id)` to prevent double-
  cancel races: all targeted non-terminal instances are marked `cancelled`
  synchronously before any `await`.
- A parent-status guard in `SubagentRunner.spawn()` that rejects spawns whose
  `spawnedBy` identifies an existing subagent whose status is not `running`.
  This prevents a subagent that is being cancelled (or has already completed or
  errored) from spawning new children during the `cancelBySession` cleanup
  window.
- Wiring in `TurnDispatcher.disposeRunner(sessionId)` to call
  `subagentRunner.cancelBySession(sessionId)` before disposing the runner.
  `disposeRunner` becomes async (`Promise<void>`) so the cascade is awaited.
- `cancelPending(sessionId)` does **not** cascade. It aborts a queued prompt but
  the session stays alive — its subagents may still be doing useful work.

## Non-Goals

- No change to `cancel(id)` behavior (single subagent cancel is unchanged).
- No change to `dispose()` behavior (nuclear shutdown cancel is unchanged).
- No change to `cancelPending` behavior beyond explicitly documenting that it
  does not cascade.
- No new subagent status type — cascade cancel uses the existing `cancelled`
  status.
- No user-visible command or Telegram surface change. Cascade cancel is an
  internal correctness fix; the user does not invoke it directly.
- No change to the `spawnedBy` field or meta format.
- No retroactive cleanup of subagents orphaned by pre-fix disposals (those
  subagents are already terminal or will time out).

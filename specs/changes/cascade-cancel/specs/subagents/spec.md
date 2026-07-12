# subagents

## ADDED Requirements

### Requirement: Cascade cancel aborts all subagents for a session

The `SubagentRunner` SHALL provide a `cancelBySession(sessionId): Promise<void>`
method that cancels every running subagent in the spawn tree rooted at the given
session id. The method SHALL first find every active subagent whose `spawnedBy`
matches the session id, then recursively find descendants whose `spawnedBy`
matches any id already in the collected set, regardless of the parent's status.
The walk is a pure parentage traversal via `spawnedBy` — flat-filtering only
direct children misses grandchildren.

A collected instance whose own status is already terminal (`completed`,
`error`, `cancelled`) SHALL be skipped — its audit trail SHALL NOT be
overwritten. A non-terminal instance is marked `cancelled`, aborted, persisted,
and torn down. Instances whose `spawnedBy` is `null` (meta predating the field)
SHALL never match and SHALL be left alone.

To prevent double-cancel races, the method SHALL mark every targeted non-
terminal instance as `cancelled` synchronously (before any `await`). After all
statuses are set, the method SHALL, for each marked instance in BFS order:

1. Call `instance.session.abort()` and swallow any errors.
2. Call `persistMetaPatch(instance, { status: "cancelled", completedAt: new Date().toISOString() })` and log any errors.
   `completedAt` is an existing optional `SubagentMeta` field already written by
   `cancel(id)` and `dispose()`; no new meta field is introduced.
3. Call `instance.unsubscribe()` and set `instance.unsubscribe = null` in a
   `finally` (or equivalent catch) so the field is nulled even if
   `unsubscribe()` throws.
4. Call `teardownInstance(instance)` and log any errors.

Errors in any per-instance step SHALL NOT stop cleanup of the remaining
instances, and `cancelBySession` SHALL resolve with `Promise<void>` without
rejecting. The method SHALL log a debug message with a stable prefix (e.g.
`cascade-cancel: subagents cancelled`) and the count of cancelled subagents once
all cleanup has been attempted.

#### Scenario: Direct children cancelled when session is disposed

- **WHEN** `cancelBySession("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `running`
- **AND** subagent B has `spawnedBy === "session-abc"` and status `running`
- **THEN** both A and B SHALL have their sessions aborted
- **AND** both A and B SHALL have status `cancelled` in memory and in `meta.json`

#### Scenario: Recursive cascade cancels grandchildren

- **WHEN** `cancelBySession("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `running`
- **AND** subagent B has `spawnedBy === A.id` and status `running`
- **THEN** both A and B SHALL be cancelled
- **AND** B SHALL be cancelled even though its `spawnedBy` is not `"session-abc"`

#### Scenario: Terminal parent with running child is still cancelled

- **WHEN** `cancelBySession("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `completed`
- **AND** subagent B has `spawnedBy === A.id` and status `running`
- **THEN** A SHALL remain `completed`
- **AND** B SHALL be cancelled because its parent A is in the session's spawn tree
- **AND** B's status SHALL be `cancelled` in memory and in `meta.json`

#### Scenario: Terminal instances are skipped

- **WHEN** `cancelBySession("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `completed`
- **THEN** A SHALL NOT be cancelled
- **AND** A's status SHALL remain `completed` in memory and in `meta.json`

#### Scenario: Null spawnedBy is never matched

- **WHEN** `cancelBySession("session-abc")` is called
- **AND** subagent A has `spawnedBy === null` and status `running`
- **THEN** A SHALL NOT be cancelled
- **AND** A SHALL continue running

#### Scenario: No subagents for the session is a no-op

- **WHEN** `cancelBySession("session-xyz")` is called
- **AND** no active subagent has `spawnedBy === "session-xyz"`
- **THEN** the method SHALL return without error
- **AND** no subagents SHALL be cancelled

#### Scenario: Synchronous status set prevents double-cancel

- **WHEN** `cancelBySession("session-abc")` is called concurrently with
  `cancel("child-a")` for a child of that session
- **THEN** whichever call marks the instance as `cancelled` first SHALL win
- **AND** the other call SHALL see a non-running status and exit as a no-op
- **AND** the instance SHALL be cancelled exactly once (one `session.abort()`)

#### Scenario: Subagents of other sessions are not affected

- **WHEN** `cancelBySession("session-abc")` is called
- **AND** subagent C has `spawnedBy === "session-def"` and status `running`
- **THEN** C SHALL NOT be cancelled
- **AND** C SHALL continue running

#### Scenario: `cancelBySession` resolves with `Promise<void>`

- **WHEN** `cancelBySession("session-abc")` is called
- **THEN** the method SHALL return a `Promise<void>`
- **AND** the promise SHALL resolve (not reject) after all targeted instances
  have been attempted

#### Scenario: `cancelBySession` writes `completedAt` to `meta.json`

- **WHEN** subagent A has `spawnedBy === "session-abc"` and status `running`
- **AND** `cancelBySession("session-abc")` is called
- **THEN** A's `meta.json` SHALL contain `status: "cancelled"`
- **AND** A's `meta.json` SHALL contain `completedAt` set to an ISO-8601 timestamp

#### Scenario: `cancelBySession` logs the cancelled count at debug level

- **WHEN** subagent A has `spawnedBy === "session-abc"` and status `running`
- **AND** subagent B has `spawnedBy === "session-abc"` and status `running`
- **AND** `cancelBySession("session-abc")` is called
- **THEN** a debug log SHALL contain the message `cascade-cancel: subagents cancelled`
- **AND** the log fields SHALL include `count` with value `2`
- **AND** the log fields SHALL include `sessionId` with value `"session-abc"`

### Requirement: Spawn rejects children of cancelled parents

`SubagentRunner.spawn()` SHALL refuse to spawn a subagent whose `spawnedBy`
identifies an existing subagent in `activeSubagents` whose status is not
`running`. This prevents a subagent that is being cancelled (status `cancelled`)
or has already completed/errored from creating new children during the
`cancelBySession` cleanup window or after its own terminal state.

#### Scenario: Child spawn rejected when parent is cancelled

- **WHEN** subagent A has `spawnedBy === "session-abc"` and status `cancelled`
- **AND** `spawn({ prompt: "work", activeScope: ..., spawnedBy: A.id })` is called
- **THEN** `spawn` SHALL throw an error
- **AND** the new subagent SHALL NOT be created

#### Scenario: Child spawn rejected when parent is completed

- **WHEN** subagent A has `spawnedBy === "session-abc"` and status `completed`
- **AND** `spawn({ prompt: "work", activeScope: ..., spawnedBy: A.id })` is called
- **THEN** `spawn` SHALL throw an error

#### Scenario: Child spawn allowed when parent is running

- **WHEN** subagent A has `spawnedBy === "session-abc"` and status `running`
- **AND** `spawn({ prompt: "work", activeScope: ..., spawnedBy: A.id })` is called
- **THEN** the new subagent SHALL be created
- **AND** its `spawnedBy` SHALL be `A.id`

#### Scenario: Top-level spawn with a session id is not rejected

- **WHEN** `spawn({ prompt: "work", activeScope: ..., spawnedBy: "session-xyz" })` is called
- **AND** no subagent in `activeSubagents` has id `"session-xyz"`
- **THEN** the new subagent SHALL be created
- **AND** its `spawnedBy` SHALL be `"session-xyz"`

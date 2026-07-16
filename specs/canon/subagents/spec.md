# subagents

## Requirements

### Requirement: SubagentRunner manages subagent lifecycle

The `SubagentRunner` class SHALL handle spawning, revival, and status tracking for all subagents. It SHALL obtain pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` from the `createPiServices()` function exported by `src/pi-host.ts`.

#### Scenario: Runner creation

- **WHEN** `SubagentRunner` is instantiated
- **THEN** it SHALL have access to shared services (AuthStorage, ModelRegistry, SettingsManager) obtained from `createPiServices()`
- **AND** it SHALL track active subagents in memory

#### Scenario: Services from pi-host

- **WHEN** `SubagentRunner.getPiServices()` is called
- **THEN** it SHALL call `createPiServices(this.cfg.goblinHome)` from `src/pi-host.ts`
- **AND** it SHALL NOT construct `AuthStorage`, `ModelRegistry`, or `SettingsManager` inline

#### Scenario: Lazy caching preserved

- **WHEN** `getPiServices()` is called twice within the same `SubagentRunner` lifetime
- **THEN** `createPiServices()` SHALL be called only once
- **AND** the cached result SHALL be returned on subsequent calls

### Requirement: Spawn subagent tool available to goblin

A `spawn_subagent` tool SHALL be registered for goblin's use, allowing dynamic creation of ad-hoc subagents.

#### Scenario: Spawn generic subagent

- **WHEN** goblin calls `spawn_subagent({prompt: "Analyze this log"})`
- **THEN** a new subagent SHALL be created with given system prompt
- **AND** it SHALL inherit parent's skills
- **AND** a subagent ID SHALL be returned

#### Scenario: Spawn with task specification

- **WHEN** spawn includes explicit task description
- **THEN** the subagent SHALL be created focused on that task
- **AND** its session SHALL be persisted to disk

### Requirement: Named subagents load isolated definitions

Named subagents (e.g., "researcher", "reviewer") SHALL load their `AGENTS.md` and `skills/` from `$GOBLIN_HOME/workspace/agents/<name>/`.

#### Scenario: Spawn named subagent

- **WHEN** `spawn_subagent({name: "researcher", prompt: "..."})` is called
- **THEN** `$GOBLIN_HOME/workspace/agents/researcher/AGENTS.md` SHALL be loaded as system prompt
- **AND** `$GOBLIN_HOME/workspace/agents/researcher/skills/` SHALL be discoverable by the subagent
- **AND** parent's skills SHALL NOT be inherited (strict isolation)

#### Scenario: Named subagent not found

- **WHEN** `spawn_subagent({name: "nonexistent"})` is called
- **THEN** it SHALL throw an error: "Named agent 'nonexistent' not found"

### Requirement: Subagent sessions persist to disk

Every subagent spawn SHALL create a persisted pi session. Generic subagents use `$GOBLIN_HOME/scratch/subagents/<id>/session.jsonl`; named agents use `$GOBLIN_HOME/workspace/agents/<name>/instances/<id>/session.jsonl`.

#### Scenario: Session creation for generic subagent

- **WHEN** a generic subagent is spawned
- **THEN** `$GOBLIN_HOME/scratch/subagents/<uuid>/session.jsonl` SHALL be created via `SessionManager.create()`
- **AND** `$GOBLIN_HOME/scratch/subagents/<uuid>/meta.json` SHALL store metadata (spawnedBy, role, timestamps)

#### Scenario: Session creation for named subagent

- **WHEN** a named subagent "researcher" is spawned
- **THEN** `$GOBLIN_HOME/workspace/agents/researcher/instances/<uuid>/session.jsonl` SHALL be created
- **AND** `$GOBLIN_HOME/workspace/agents/researcher/instances/<uuid>/meta.json` SHALL store metadata

#### Scenario: Conversation accumulation

- **WHEN** subagent processes multiple turns
- **THEN** each SHALL be appended to `session.jsonl`

### Requirement: Subagent revival loads persisted session

The `revive(id, prompt)` method on `SubagentRunner` SHALL load a subagent's conversation from disk and continue it, returning the subagent's response as a string.

#### Scenario: Revive after restart

- **WHEN** goblin restarts and calls `revive("abc123", "Check results")`
- **THEN** subagent "abc123" SHALL be loaded from its `session.jsonl`
- **AND** conversation history SHALL be intact
- **AND** the new prompt SHALL be processed
- **AND** the response SHALL be returned as a string

#### Scenario: Revive with new prompt

- **WHEN** revive is called with a prompt
- **THEN** the subagent SHALL receive it as a new user message
- **AND** it SHALL respond based on combined history + new prompt

### Requirement: Recursion depth capped at 3

Subagents SHALL be able to spawn their own subagents, but the depth SHALL be limited to 3 to prevent runaway.

#### Scenario: Depth 1 spawn

- **WHEN** goblin spawns subagent A
- **AND** A spawns B
- **THEN** depth is 2, allowed

#### Scenario: Depth 3 blocked

- **WHEN** depth 3 subagent tries to spawn
- **THEN** the spawn SHALL fail with error "Maximum subagent depth reached (3)"

### Requirement: Subagent activity appears in goblin status

When a subagent is running, its activity SHALL be reported to goblin via `onStatusUpdate` callbacks.

#### Scenario: Subagent starts work

- **WHEN** subagent begins processing
- **THEN** goblin's status line SHALL show "🧠 Researcher thinking..."

#### Scenario: Subagent completes

- **WHEN** subagent finishes and returns result
- **THEN** goblin SHALL receive the result
- **AND** status SHALL update to show completion

### Requirement: No beta tools for subagents

Subagents SHALL NOT have access to Telegram-native (β) tools. They operate without direct Telegram surface. Subagents MAY receive the `spawn_subagent` tool (α) to enable recursive spawning, and the `revive_subagent` tool (α) to enable continuation of nested subagents.

#### Scenario: Subagent tool set

- **WHEN** a subagent is spawned
- **THEN** its tools SHALL be α (pi built-in) plus optionally `spawn_subagent` and `revive_subagent`
- **AND** no β (Telegram-native) tools SHALL be present

### Requirement: Generic subagents inherit parent skills

Generic (unnamed) subagents SHALL discover skills from the parent's `$GOBLIN_HOME/workspace/skills/` directory.

#### Scenario: Generic spawn

- **WHEN** `spawn_subagent({prompt: "..."})` without name
- **THEN** the subagent SHALL have access to `$GOBLIN_HOME/workspace/skills/`
- **AND** it SHALL NOT have access to named agent isolated skills

### Requirement: Subagent results returned to caller

When a subagent completes, its final output SHALL be returned to the spawner (goblin or parent subagent).

#### Scenario: Goblin spawns researcher

- **WHEN** researcher subagent finishes analysis
- **THEN** its final response SHALL be returned to goblin
- **AND** goblin SHALL incorporate it into its own context

### Requirement: List subagents shows active instances

The `list()` method SHALL return all active (running or recent) subagents with their IDs, status, and spawned time.

#### Scenario: List active subagents

- **WHEN** `list()` is called
- **THEN** it SHALL return an array of `{id, name, role, status, spawnedAt}`
- **AND** status SHALL be one of: running, completed, cancelled, error

#### Scenario: List when empty

- **WHEN** `list()` is called with no active subagents
- **THEN** it SHALL return an empty array

### Requirement: Cancel subagent aborts execution

The `cancel(id)` method SHALL abort the specified subagent's current turn.

#### Scenario: Cancel running subagent

- **WHEN** `cancel("abc123")` is called
- **THEN** subagent "abc123" SHALL have its session aborted
- **AND** its status SHALL be updated to cancelled

#### Scenario: Cancel nonexistent subagent

- **WHEN** `cancel("xyz999")` is called for nonexistent ID
- **THEN** it SHALL throw an error: "Subagent not found"

### Requirement: Revive subagent tool available to goblin

A `revive_subagent` tool SHALL be registered for goblin's use, allowing continuation of previously completed, cancelled, or errored subagents.

#### Scenario: Revive completed subagent

- **WHEN** goblin calls `revive_subagent({id: "abc123", prompt: "Go deeper"})`
- **THEN** subagent "abc123" SHALL be loaded from its persisted session
- **AND** the new prompt SHALL be processed
- **AND** the response SHALL be returned

#### Scenario: Revive nonexistent subagent

- **WHEN** `revive_subagent({id: "xyz999", prompt: "..."})` is called for nonexistent ID
- **THEN** it SHALL throw an error: "Subagent not found"

### Requirement: SubagentRunner graceful shutdown

The `dispose()` method SHALL cancel all running subagents, dispose their sessions, and clear the active map.

#### Scenario: Dispose with running subagents

- **WHEN** `dispose()` is called with active running subagents
- **THEN** each running subagent SHALL be aborted
- **AND** their status SHALL be updated to cancelled
- **AND** the active subagent map SHALL be empty

### Requirement: Named agent names are sanitized

Agent names SHALL be validated to prevent path traversal.

#### Scenario: Invalid name rejected

- **WHEN** a name containing characters outside `[a-zA-Z0-9_-]` is provided
- **THEN** spawn SHALL throw an error matching "Invalid agent name"

### Requirement: Subagent event dispatch goes through shared dispatchAgentEvent

The subagent runtime SHALL dispatch each pi `AgentSessionEvent` by constructing a local `TurnCallbacks` adapter and delegating to `dispatchAgentEvent(event, callbacks)` from `src/agent/events.ts`. The adapter SHALL map the typed `TurnCallbacks` methods to the subagent's existing callback surface:

- `onTextDelta(delta)` → `hooks.onText(delta)`
- `onToolStart(name)` → `instance.onStatusUpdate?.(``tool: ${name}``)`
- `onToolEnd(name, isError)` → `instance.onStatusUpdate?.(``tool ${isError ? "error" : "ok"}: ${name}``)`
- `onStatusUpdate(message)` → `instance.onStatusUpdate?.(message)`
- `onAgentEnd()` → `hooks.onEnd()`

The adapter SHALL be constructed fresh per-event (no retained state). No inline `switch` statement on event type SHALL remain in the subagent runtime.

#### Scenario: Subagent receives a text delta event

- **WHEN** a `message_update` event with `text_delta` arrives for a subagent
- **THEN** `hooks.onText(delta)` SHALL be called with the delta string
- **AND** the call SHALL be identical in timing and value to the prior inline switch

#### Scenario: Subagent receives a tool start event

- **WHEN** a `tool_execution_start` event arrives for a subagent
- **THEN** `instance.onStatusUpdate("tool: <name>")` SHALL be called

#### Scenario: Subagent completes

- **WHEN** an `agent_end` event arrives for a subagent
- **THEN** `hooks.onEnd()` SHALL be called exactly once

### Requirement: Anonymous subagents inherit parent's active memory scope

When `SubagentRunner` spawns a generic (unnamed) subagent, the subagent SHALL receive `memory_read`, `memory_read_index`, and `memory_write` tool definitions wired to the *parent's* active scope. Both reads and writes resolve as if the subagent were the parent agent itself: `memory_write({target: "memory"})` from the subagent writes to the parent's `state/memory/topics/<chat>/<topic>/memory.md` (or `state/memory/general/memory.md` for DM/supergroup-no-topic parents).

Anonymous subagents have no named-agent identity; `memory_write({target: "agent"})` SHALL be rejected for them with the same error path as the main goblin agent.

#### Scenario: Generic subagent in a topic writes to parent's scope

- **WHEN** the main agent in topic `42` spawns a generic subagent
- **AND** the subagent calls `memory_write({action: "add", target: "memory", content: "..."})`
- **THEN** the entry SHALL be appended to `state/memory/topics/<chat>/42/memory.md`
- **AND** the resulting git commit SHALL have subject `memory: add in topics/<chat>/42`

#### Scenario: Generic subagent target=agent is rejected

- **WHEN** a generic subagent calls `memory_write({action: "add", target: "agent", ...})`
- **THEN** the tool SHALL return an error stating that `target = "agent"` is only valid for named subagents
- **AND** no file SHALL be modified

### Requirement: Named subagents have a three-tier memory model

When `SubagentRunner` spawns a named subagent (loaded from `$GOBLIN_HOME/workspace/agents/<name>/`), the subagent's per-turn memory snapshot SHALL include three tiers:

1. **Identity tier (always loaded):** the global `user.md` and the named agent's own `state/memory/agents/<name>/memory.md` persona memory.
2. **Active tier (always loaded):** the parent's active scope `memory.md` (`state/memory/topics/<chat>/<topic>/memory.md` or `state/memory/general/memory.md`).
3. **Progressive tier (on-demand):** the cross-scope index, fetched via `memory_read_index` and inspected on demand via `memory_read({scope: ...})`.

All three tiers are writable by the named subagent through `memory_write`:
- `target: "user"` → global `user.md`.
- `target: "memory"` → parent's active scope.
- `target: "agent"` → named subagent's own `state/memory/agents/<name>/memory.md`.

The named subagent MUST NOT be given a path-based scope argument on `memory_write`. The active scope is resolved server-side from the parent's session locator (for `target: "memory"`) and from the subagent's named identity (for `target: "agent"`).

#### Scenario: Named subagent persona is loaded into snapshot

- **WHEN** a named subagent `researcher` is spawned from a session in topic `42`
- **AND** `state/memory/agents/researcher/memory.md` has content
- **THEN** the subagent's per-turn snapshot SHALL include the persona file under a `## agent persona` section
- **AND** the snapshot SHALL also include the global `## user.md` and the parent's active `## memory.md`

#### Scenario: Named subagent writes to its own persona

- **WHEN** named subagent `researcher` calls `memory_write({action: "add", target: "agent", content: "PubMed paywall workaround: ..."})`
- **THEN** the entry SHALL be appended to `state/memory/agents/researcher/memory.md`
- **AND** the git commit SHALL have subject `memory: add in agents/researcher`
- **AND** no other scope file SHALL be modified

#### Scenario: Named subagent writes findings to parent's active scope

- **WHEN** named subagent `researcher` spawned from topic `42` calls `memory_write({action: "add", target: "memory", content: "..."})`
- **THEN** the entry SHALL be appended to `state/memory/topics/<chat>/42/memory.md`
- **AND** the named subagent's own persona file SHALL NOT be modified

### Requirement: Subagent memory access uses the same tool surface as the main agent

The three memory tools (`memory_read`, `memory_read_index`, `memory_write`) SHALL have identical schemas regardless of whether they are registered on the main `AgentRunner` or on a `SubagentRunner`. What differs is solely the resolution of the active scope and (for named subagents) the meaning of `target: "agent"`. The agent-facing schema MUST NOT contain runner-type-specific branches.

#### Scenario: Tool schema parity

- **WHEN** the JSON schema for `memory_write` is compared between the main agent's tool registration and a generic subagent's tool registration
- **THEN** the schemas SHALL be byte-identical

#### Scenario: target=agent error parity

- **WHEN** `memory_write({target: "agent"})` is called from any caller without a named identity (main agent or generic subagent)
- **THEN** the returned error message SHALL be the same string in every case

### Requirement: Background reflection excludes subagent transcripts

The automatic memory reflection pipeline SHALL run only for main `AgentRunner` sessions. Subagent transcripts SHALL NOT be reflected automatically by this change, even though subagents may continue to use explicit memory tools.

#### Scenario: Subagent completes without reflection

- **WHEN** a subagent emits `agent_end`
- **THEN** no background reflection pass SHALL be scheduled for the subagent session
- **AND** any memory changes from that subagent SHALL come only from explicit `memory_write` tool calls

#### Scenario: Named subagent persona remains explicit

- **WHEN** a named subagent completes a turn without calling `memory_write({target: "agent", ...})`
- **THEN** `agents/<name>/memory.md` SHALL NOT be modified by automatic reflection

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
statuses are set, the method SHALL clean up all marked instances concurrently
(starting all aborts in parallel so a parent that is blocked on a child result
can be unblocked when the child's abort settles). For each marked instance, the
following steps SHALL run in their own try/catch so one failing step does not
abort the remaining steps or other instances:

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

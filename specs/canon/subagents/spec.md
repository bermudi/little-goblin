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

The subagent revival operation SHALL load and continue the persisted pi conversation history and SHALL process the new prompt as currently accepted. Revival SHALL be treated as a new invocation: its caller MUST supply the reviving parent runtime's captured memory context, and the revived invocation SHALL derive its caller descriptor from the persisted role/name. It MUST NOT restore active memory authority from persisted legacy `activeScope`, Conversation creation metadata, or current binding lookup.

`TurnDispatcher` SHALL own the command-facing revival operation. It SHALL execute under a lifecycle-provided current-binding guard and, before `AgentSession` creation, verify that the requested Surface is still bound to the requested Conversation, that the registered parent runner is current for that Surface, and that its captured `sourceSurfaceId` equals that Surface. It SHALL attach the revived invocation before the guard releases. Command handlers MUST NOT independently join a runner/capture to lifecycle binding state. A binding replacement SHALL wait for the guarded operation; an absent, stale, internal, or Surface-mismatched runtime SHALL fail without creating a subagent session.

#### Scenario: Revive after restart

- **WHEN** a parent runtime revives a persisted subagent after restart
- **THEN** the prior subagent conversation history SHALL be loaded
- **AND** the new invocation SHALL capture the reviving parent runtime's ActiveScope

#### Scenario: Conversation moved before revival

- **GIVEN** a subagent was originally spawned from Surface X
- **AND** its owning Conversation now has a runtime on Surface Y
- **WHEN** that runtime revives the subagent
- **THEN** the revival invocation SHALL use Y's captured ActiveScope
- **AND** SHALL preserve the subagent history without treating X's persisted scope as live authority

#### Scenario: Revival without parent context is rejected

- **WHEN** revival is requested without an invoking runtime memory capture
- **THEN** it SHALL fail before creating a subagent AgentSession

#### Scenario: Binding rotation races revival

- **GIVEN** a Conversation is bound to Surface X with a current captured runtime
- **WHEN** revival begins on X while a lifecycle transition requests replacement on Y
- **THEN** revival SHALL either attach using X before the transition proceeds or fail before creating a subagent AgentSession
- **AND** it SHALL never create an invocation from X after Y becomes current

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

A generic subagent SHALL receive the parent runtime's captured ActiveScope and an anonymous-subagent caller descriptor. Its `memory_search` and `memory_write` tools SHALL consume that immutable invocation capture. `target = "memory"` SHALL resolve to the captured topic/general scope, while `target = "agent"` SHALL be rejected. The subagent MUST NOT resolve a parent locator or current binding.

#### Scenario: Generic subagent writes captured topic

- **WHEN** a generic subagent captured topic 42 and writes `target = "memory"`
- **THEN** the entry SHALL be inserted in `topics/<chatId>/42`
- **AND** a later parent move SHALL not retarget the write

#### Scenario: Generic persona write is rejected

- **WHEN** a generic subagent writes `target = "agent"`
- **THEN** the call SHALL fail with the same non-named-caller error as the main agent

### Requirement: Named subagents have a three-tier memory model

A named subagent SHALL preserve the accepted three-tier model: global user plus its own persona identity tier, the parent invocation's captured active tier, and caller-authorized progressive discovery. Its named caller descriptor SHALL control persona visibility and `target = "agent"`; its captured ActiveScope SHALL control `target = "memory"` and same-chat discovery. Named identity MUST NOT be added to or resolved through `Surface → ActiveScope`.

All tiers SHALL be frozen/queried through the invocation capture. The subagent SHALL not receive a path-based scope write, parent locator, binding reader, or other persona scopes.

#### Scenario: Named context keeps persona separate

- **WHEN** named subagent `researcher` is spawned from a topic runtime
- **THEN** its frozen context SHALL include global user memory, the captured topic memory, and `agents/researcher`
- **AND** SHALL exclude other persona scopes

#### Scenario: Named writes use separate authorities

- **WHEN** `researcher` writes `target = "memory"` and then `target = "agent"`
- **THEN** the first write SHALL use the captured ActiveScope
- **AND** the second SHALL use the named caller descriptor

### Requirement: Subagent memory access uses the same tool surface as the main agent

Subagents SHALL use the same `memory_search` and `memory_write` schemas as the main agent. The schemas SHALL remain caller-agnostic; behavior SHALL differ only through the validated invocation memory capture. Generic and named subagents MUST NOT receive locator, Surface, arbitrary-scope, or policy-knob inputs. Persona rejection and active-scope write behavior SHALL retain parity with the main memory module.

#### Scenario: Tool schema parity

- **WHEN** main, generic-subagent, and named-subagent memory tool schemas are compared
- **THEN** they SHALL be identical
- **AND** none SHALL expose runtime memory authority as model input

#### Scenario: Runtime capture differs behind the same schema

- **WHEN** callers invoke identical memory tool inputs
- **THEN** the tool implementation SHALL apply each caller's prevalidated capture
- **AND** SHALL not branch on a model-supplied runner kind

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

### Requirement: Subagent memory context is captured per invocation

Every subagent spawn or revival invocation SHALL receive a captured memory context from the invoking parent runtime. The invocation capture SHALL contain the parent's already-projected ActiveScope and a caller descriptor derived from the child role; it MUST NOT contain a parent locator or binding reader. It SHALL remain immutable until that invocation terminates.

A generic child SHALL use the inherited ActiveScope with an anonymous-subagent caller descriptor. A named child SHALL use the inherited ActiveScope with its own named-subagent caller descriptor. Recursive children SHALL inherit their immediate parent invocation's ActiveScope unchanged and derive only their own caller descriptor. Invocation metadata MAY persist the capture for audit, but persisted context MUST NOT become live authority for a later revival.

#### Scenario: Parent moves after spawn

- **GIVEN** a parent runtime on Surface X spawns an attached subagent
- **WHEN** the parent Conversation later moves to Surface Y
- **THEN** runtime invalidation SHALL cancel the attached subagent before the replacement becomes current
- **AND** its recorded invocation authority SHALL remain X and SHALL not query or retarget to Y

#### Scenario: Recursive child inherits capture

- **WHEN** a subagent recursively spawns a child
- **THEN** the child SHALL receive the same captured ActiveScope
- **AND** a named child SHALL add only its own persona caller identity

#### Scenario: Persisted context is audit-only

- **WHEN** an old subagent invocation's metadata contains a captured ActiveScope
- **THEN** status and diagnostics MAY display it
- **AND** a new revival invocation SHALL not use it as current routing authority

### Requirement: Internal extraction does not invent parent memory context

A model invocation used solely for internal dreaming extraction SHALL use the explicit Surface-free internal path. It SHALL not receive ordinary subagent memory tools, synthesize an ActiveScope, or inherit the dreaming compatibility session's `chatId: 0`.

#### Scenario: Dreaming invokes model extraction

- **WHEN** dreaming requests structured candidate extraction
- **THEN** the model invocation SHALL have no source Surface or active memory write scope
- **AND** promotion scope SHALL be resolved later from transcript provenance

### Requirement: Generic subagents filter deployment prompt files from context discovery

A generic subagent's `DefaultResourceLoader` SHALL receive an `agentsFilesOverride` that filters the resolved paths of `$GOBLIN_HOME/workspace/SOUL.md`, `$GOBLIN_HOME/workspace/AGENTS.md`, and `$GOBLIN_HOME/workspace/HEARTBEAT.md` out of any pi-discovered `agentsFiles` list while leaving other discovered context files (e.g., a project `AGENTS.md`) intact. Named subagents are unaffected because they use `noContextFiles: true` and their own `AGENTS.md` as the system prompt.

#### Scenario: Generic subagent does not inherit workspace SOUL/AGENTS/HEARTBEAT

- **WHEN** a generic subagent is spawned and pi's default context discovery would surface `$GOBLIN_HOME/workspace/SOUL.md`, `AGENTS.md`, or `HEARTBEAT.md`
- **THEN** the `agentsFilesOverride` SHALL remove those three resolved paths from the discovered set
- **AND** the generic subagent SHALL NOT receive their contents as context

#### Scenario: Project AGENTS.md is preserved for generic subagents

- **WHEN** a generic subagent is spawned under a project execution environment whose project `AGENTS.md` is discovered
- **THEN** the `agentsFilesOverride` SHALL NOT remove the project `AGENTS.md`
- **AND** that file SHALL remain available as context

#### Scenario: Named subagents are unaffected

- **WHEN** a named subagent is spawned
- **THEN** its loader SHALL continue to use `noContextFiles: true` with its own `AGENTS.md` as the system prompt
- **AND** no `agentsFilesOverride` filtering SHALL be required for the named path

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

Named subagents (e.g., "researcher", "reviewer") SHALL load their `AGENTS.md` and `skills/` from `~/goblin/agents/<name>/`.

#### Scenario: Spawn named subagent

- **WHEN** `spawn_subagent({name: "researcher", prompt: "..."})` is called
- **THEN** `~/goblin/agents/researcher/AGENTS.md` SHALL be loaded as system prompt
- **AND** `~/goblin/agents/researcher/skills/` SHALL be discoverable by the subagent
- **AND** parent's skills SHALL NOT be inherited (strict isolation)

#### Scenario: Named subagent not found

- **WHEN** `spawn_subagent({name: "nonexistent"})` is called
- **THEN** it SHALL throw an error: "Named agent 'nonexistent' not found"

### Requirement: Subagent sessions persist to disk

Every subagent spawn SHALL create a persisted pi session. Generic subagents use `~/goblin/subagents/<id>/session.jsonl`; named agents use `~/goblin/agents/<name>/instances/<id>/session.jsonl`.

#### Scenario: Session creation for generic subagent

- **WHEN** a generic subagent is spawned
- **THEN** `~/goblin/subagents/<uuid>/session.jsonl` SHALL be created via `SessionManager.create()`
- **AND** `~/goblin/subagents/<uuid>/meta.json` SHALL store metadata (spawnedBy, role, timestamps)

#### Scenario: Session creation for named subagent

- **WHEN** a named subagent "researcher" is spawned
- **THEN** `~/goblin/agents/researcher/instances/<uuid>/session.jsonl` SHALL be created
- **AND** `~/goblin/agents/researcher/instances/<uuid>/meta.json` SHALL store metadata

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

Generic (unnamed) subagents SHALL discover skills from the parent's `~/goblin/skills/` directory.

#### Scenario: Generic spawn

- **WHEN** `spawn_subagent({prompt: "..."})` without name
- **THEN** the subagent SHALL have access to `~/goblin/skills/`
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

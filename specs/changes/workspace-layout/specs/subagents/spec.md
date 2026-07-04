# subagents

## MODIFIED Requirements

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

### Requirement: Generic subagents inherit parent skills

Generic (unnamed) subagents SHALL discover skills from the parent's `$GOBLIN_HOME/workspace/skills/` directory.

#### Scenario: Generic spawn

- **WHEN** `spawn_subagent({prompt: "..."})` without name
- **THEN** the subagent SHALL have access to `$GOBLIN_HOME/workspace/skills/`
- **AND** it SHALL NOT have access to named agent isolated skills

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

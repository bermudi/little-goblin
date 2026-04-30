# subagents

## ADDED Requirements

### Requirement: Anonymous subagents inherit parent's active memory scope

When `SubagentRunner` spawns a generic (unnamed) subagent, the subagent SHALL receive `memory_read`, `memory_read_index`, and `memory_write` tool definitions wired to the *parent's* active scope. Both reads and writes resolve as if the subagent were the parent agent itself: `memory_write({target: "memory"})` from the subagent writes to the parent's `topics/<chat>/<topic>/memory.md` (or `general/memory.md` for DM/supergroup-no-topic parents).

Anonymous subagents have no named-agent identity; `memory_write({target: "agent"})` SHALL be rejected for them with the same error path as the main goblin agent.

#### Scenario: Generic subagent in a topic writes to parent's scope

- **WHEN** the main agent in topic `42` spawns a generic subagent
- **AND** the subagent calls `memory_write({action: "add", target: "memory", content: "..."})`
- **THEN** the entry SHALL be appended to `topics/<chat>/42/memory.md`
- **AND** the resulting git commit SHALL have subject `memory: add in topics/<chat>/42`

#### Scenario: Generic subagent target=agent is rejected

- **WHEN** a generic subagent calls `memory_write({action: "add", target: "agent", ...})`
- **THEN** the tool SHALL return an error stating that `target = "agent"` is only valid for named subagents
- **AND** no file SHALL be modified

### Requirement: Named subagents have a three-tier memory model

When `SubagentRunner` spawns a named subagent (loaded from `~/goblin/agents/<name>/`), the subagent's per-turn memory snapshot SHALL include three tiers:

1. **Identity tier (always loaded):** the global `user.md` and the named agent's own `agents/<name>/memory.md` persona memory.
2. **Active tier (always loaded):** the parent's active scope `memory.md` (`topics/<chat>/<topic>/memory.md` or `general/memory.md`).
3. **Progressive tier (on-demand):** the cross-scope index, fetched via `memory_read_index` and inspected on demand via `memory_read({scope: ...})`.

All three tiers are writable by the named subagent through `memory_write`:
- `target: "user"` → global `user.md`.
- `target: "memory"` → parent's active scope.
- `target: "agent"` → named subagent's own `agents/<name>/memory.md`.

The named subagent MUST NOT be given a path-based scope argument on `memory_write`. The active scope is resolved server-side from the parent's session locator (for `target: "memory"`) and from the subagent's named identity (for `target: "agent"`).

#### Scenario: Named subagent persona is loaded into snapshot

- **WHEN** a named subagent `researcher` is spawned from a session in topic `42`
- **AND** `agents/researcher/memory.md` has content
- **THEN** the subagent's per-turn snapshot SHALL include the persona file under a `## agent persona` section
- **AND** the snapshot SHALL also include the global `## user.md` and the parent's active `## memory.md`

#### Scenario: Named subagent writes to its own persona

- **WHEN** named subagent `researcher` calls `memory_write({action: "add", target: "agent", content: "PubMed paywall workaround: ..."})`
- **THEN** the entry SHALL be appended to `agents/researcher/memory.md`
- **AND** the git commit SHALL have subject `memory: add in agents/researcher`
- **AND** no other scope file SHALL be modified

#### Scenario: Named subagent writes findings to parent's active scope

- **WHEN** named subagent `researcher` spawned from topic `42` calls `memory_write({action: "add", target: "memory", content: "..."})`
- **THEN** the entry SHALL be appended to `topics/<chat>/42/memory.md`
- **AND** the named subagent's own persona file SHALL NOT be modified

### Requirement: Subagent memory access uses the same tool surface as the main agent

The three memory tools (`memory_read`, `memory_read_index`, `memory_write`) SHALL have identical schemas regardless of whether they are registered on the main `AgentRunner` or on a `SubagentRunner`. What differs is solely the resolution of the active scope and (for named subagents) the meaning of `target: "agent"`. The agent-facing schema MUST NOT contain runner-type-specific branches.

#### Scenario: Tool schema parity

- **WHEN** the JSON schema for `memory_write` is compared between the main agent's tool registration and a generic subagent's tool registration
- **THEN** the schemas SHALL be byte-identical

#### Scenario: target=agent error parity

- **WHEN** `memory_write({target: "agent"})` is called from any caller without a named identity (main agent or generic subagent)
- **THEN** the returned error message SHALL be the same string in every case

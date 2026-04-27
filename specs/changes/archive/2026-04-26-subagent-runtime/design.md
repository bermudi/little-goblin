# Subagent Runtime — Design

## Architecture

```
Goblin (main agent) or Subagent A
         │
         ▼ spawn_subagent tool call
┌─────────────────────────────────────┐
│ SubagentRunner.spawn()              │
│                                     │
│  ┌─ Generic subagent ─────────────┐│
│  │ • System prompt from args      ││
│  │ • Inherit parent's skills      ││
│  │ • Session at subagents/<id>/   ││
│  └─────────────────────────────────┘│
│                                     │
│  ┌─ Named subagent ────────────────┐│
│  │ • Load ~/goblin/agents/<name>/  ││
│  │ • AGENTS.md = system prompt     ││
│  │ • Isolated skills/ directory    ││
│  │ • No parent skill inheritance   ││
│  └─────────────────────────────────┘│
│                                     │
│  • Depth check (≤3)                 │
│  • Create pi SessionManager.create()│
│  • Persist to subagents/<id>/      │
│  • Track in memory map              │
└──────────────────┬──────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
   Revive later          Complete
   (load session)       (return result)
```

## Decisions

### Two subagent types: generic vs named

**Chosen:** Generic subagents (ad-hoc, inherit skills) and named subagents (specialists, isolated skills).

**Why:** Most tasks need goblin's context (generic). Some need specialist knowledge without goblin's baggage (named). Named agents have their own evolving `AGENTS.md` and skill set.

**Named agent discovery:** Directory `~/goblin/agents/<name>/` with `AGENTS.md` required. Optional `skills/` subdirectory.

### Strict skill isolation for named agents

**Chosen:** Named subagents do NOT inherit parent skills. They only see their own `~/goblin/agents/<name>/skills/`.

**Why:** Named agents are specialists. If "Researcher" depends on goblin's "git" skill, we can't reason about what Researcher knows without looking at goblin's state. Strict isolation makes named agents predictable and portable.

**Trade-off:** Can't easily use goblin's accumulated knowledge in a named agent. Acceptable — named agents are for focused tasks.

### Persisted pi sessions for revival

**Chosen:** Subagents use `SessionManager.create(cwd)` not `inMemory()`. Sessions persist to `~/goblin/subagents/<id>/session.jsonl`.

**Why:** Revival is a core v1 requirement. User or goblin must be able to return to a subagent later. pi's persisted sessions handle branching/compaction automatically.

**Location:** 
- Generic: `~/goblin/subagents/<id>/session.jsonl`
- Named: `~/goblin/agents/<name>/instances/<id>/session.jsonl`

### Depth cap of 3

**Chosen:** Subagents can spawn subagents, but depth is limited to 3 (goblin → A → B → C, C cannot spawn).

**Why:** Prevents runaway recursion. Most use cases are depth 1-2. Depth 3 allows complex orchestration without infinite risk.

**Tracking:** Each `SubagentRunner` instance tracks its depth. Spawn call includes `depth + 1`.

### No β tools for subagents

**Chosen:** Subagents run with `customTools: []`. No Telegram access.

**Why:** Subagents have no Telegram surface. They're pure compute. All results flow back through the spawner.

### Shared services, separate sessions

**Chosen:** All subagents share goblin's `AuthStorage`, `ModelRegistry`, `SettingsManager` (pointing at `~/goblin/pi-agent/`), but each has its own `SessionManager` for conversation history.

**Why:** Shared services = shared auth/models. Separate sessions = isolated conversation history per subagent.

### Status reporting via callbacks

**Chosen:** Subagents report activity to parent via `onStatusUpdate` callback, which propagates to goblin's `MessageBuffer`.

**Implementation:** When spawning, parent provides a callback wrapper that prefixes status with subagent name: "🧠 Researcher thinking..."

## File Changes

### New files

- **`src/subagents/mod.ts`** — `SubagentRunner` class:
  - `spawn(options: SpawnOptions): Promise<SubagentHandle>`
  - `revive(id: string, prompt: string): Promise<string>`
  - `list(): SubagentInfo[]`
  - `cancel(id: string): Promise<void>`
  - Internal: depth tracking, named agent loading, skill path resolution.

- **`src/subagents/types.ts`** — Types: `SpawnOptions`, `SubagentHandle`, `SubagentInfo`, `NamedAgentDefinition`.

- **`src/subagents/mod.test.ts`** — Tests:
  - Spawn generic, verify skill inheritance.
  - Spawn named, verify isolation.
  - Depth cap enforcement.
  - Revival loads persisted conversation.
  - Status callbacks propagate to parent.

### Modified files

- **`src/agent/mod.ts`** — Register `spawn_subagent` tool when creating `AgentSession`.
  - Tool implementation delegates to `SubagentRunner`.
  - Pass current depth (0 for goblin, 1+ for subagents).
  - Return subagent ID to LLM.

- **`src/bot.ts`** — Instantiate `SubagentRunner` alongside `AgentRunner`:
  ```typescript
  const subagentRunner = new SubagentRunner(cfg);
  // Pass to AgentRunner so spawn_subagent tool can use it
  ```

- **`src/config.ts`** — Ensure `~/goblin/agents/` and `~/goblin/subagents/` directories exist.

### New directory structure

```
~/goblin/
├── agents/                    # named agent definitions
│   └── researcher/
│       ├── AGENTS.md
│       └── skills/
│           └── research.md
├── subagents/                 # generic subagent instances
│   └── <uuid>/
│       ├── session.jsonl
│       └── meta.json
└── ...
```

## Data flow: spawn → complete → return

1. Goblin calls `spawn_subagent({prompt: "Analyze logs"})`
2. `SubagentRunner.spawn()`:
   - Check depth ≤ 3
   - Create `~/goblin/subagents/<uuid>/` with `meta.json`
   - Create pi `SessionManager` at that path
   - Build system prompt (inherit skills or load named AGENTS.md)
   - Call `session.sendUserMessage(prompt)`
   - Stream status to parent's callback
3. Subagent runs to completion
4. Subagent's final response returned to `spawn_subagent` tool result
5. Goblin receives result in its context

## Data flow: revive

1. User or goblin calls `runner.revive("abc123", "Check results")`
2. `SubagentRunner.revive()`:
   - Load `~/goblin/subagents/abc123/session.jsonl` via pi
   - Resume the pi session
   - Send new prompt
3. Subagent responds, result returned as string to caller

## Cross-cutting: status display

Subagent activity appears in goblin's status line via this path:
```
subagent.onStatusUpdate → parent's callback → goblin's MessageBuffer → Telegram status message
```

This is why subagents don't have β tools — all UI flows through the parent.

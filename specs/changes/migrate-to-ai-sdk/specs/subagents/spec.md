# subagents

## MODIFIED Requirements

### Requirement: SubagentRunner manages subagent lifecycle

The `SubagentRunner` class SHALL handle spawning, revival, and status tracking for all subagents. It SHALL construct AI SDK `LanguageModel` instances from the resolved provider config. No shared service objects (AuthStorage, ModelRegistry, SettingsManager) are needed — providers are constructed directly with API keys.

#### Scenario: Runner creation

- **WHEN** `SubagentRunner` is instantiated
- **THEN** it SHALL track active subagents in memory
- **AND** it SHALL NOT require any pre-initialized service objects

### Requirement: Subagent sessions persist to disk

Every subagent spawn SHALL create a persisted conversation history. Generic subagents use `~/goblin/subagents/<id>/`; named agents use `~/goblin/agents/<name>/instances/<id>/`. The conversation history SHALL be stored as a JSONL file containing `ModelMessage[]` entries.

#### Scenario: Session creation for generic subagent

- **WHEN** a generic subagent is spawned
- **THEN** `~/goblin/subagents/<uuid>/messages.jsonl` SHALL be created
- **AND** `~/goblin/subagents/<uuid>/meta.json` SHALL store metadata (spawnedBy, role, timestamps)

#### Scenario: Session creation for named subagent

- **WHEN** a named subagent "researcher" is spawned
- **THEN** `~/goblin/agents/researcher/instances/<uuid>/messages.jsonl` SHALL be created
- **AND** `~/goblin/agents/researcher/instances/<uuid>/meta.json` SHALL store metadata

#### Scenario: Conversation accumulation

- **WHEN** subagent processes multiple turns
- **THEN** each message SHALL be appended to `messages.jsonl`

### Requirement: Subagent revival loads persisted session

The `revive(id, prompt)` method on `SubagentRunner` SHALL load a subagent's conversation history from disk and continue it using AI SDK's `generateText()`, returning the subagent's response as a string.

#### Scenario: Revive after restart

- **WHEN** goblin restarts and calls `revive("abc123", "Check results")`
- **THEN** subagent "abc123" SHALL be loaded from its `messages.jsonl`
- **AND** conversation history SHALL be intact
- **AND** the new prompt SHALL be processed
- **AND** the response SHALL be returned as a string

### Requirement: Subagent event dispatch goes through shared dispatchAgentEvent

The subagent runtime SHALL use AI SDK's `fullStream` (for streaming subagents) or step results (for `generateText` subagents) and dispatch events by constructing a local `TurnCallbacks` adapter and delegating to `dispatchStreamEvent(part, callbacks)` from `src/agent/events.ts`.

#### Scenario: Subagent receives a text delta event

- **WHEN** a `text-delta` stream part arrives for a subagent
- **THEN** `hooks.onText(delta)` SHALL be called with the delta string

#### Scenario: Subagent completes

- **WHEN** a `finish` stream part arrives for a subagent
- **THEN** `hooks.onEnd()` SHALL be called exactly once

### Requirement: Named subagents load isolated definitions

Named subagents SHALL load their `AGENTS.md` from `~/goblin/agents/<name>/` as the system prompt. The `skills/` directory under the named agent's root SHALL be scanned for `SKILL.md` files; found skills SHALL be appended to the system prompt. No `DefaultResourceLoader` or pi resource loading framework is used — goblin reads files directly.

Parent skills SHALL NOT be inherited — strict isolation. If `AGENTS.md` does not exist, spawn SHALL throw an error. If `skills/` is absent or empty, the system prompt SHALL contain only the `AGENTS.md` content.

#### Scenario: Spawn named subagent with skills

- **WHEN** `spawn_subagent({name: "researcher", prompt: "..."})` is called
- **AND** `~/goblin/agents/researcher/skills/` contains SKILL.md files
- **THEN** `~/goblin/agents/researcher/AGENTS.md` SHALL be loaded as system prompt
- **AND** skill content from `skills/` SHALL be appended to the system prompt
- **AND** parent's skills SHALL NOT be available

#### Scenario: Named agent with no skills directory

- **WHEN** `spawn_subagent({name: "minimal"})` is called
- **AND** `~/goblin/agents/minimal/skills/` does not exist
- **THEN** the system prompt SHALL contain only `AGENTS.md` content
- **AND** no error SHALL be thrown

### Requirement: Cancel subagent aborts execution

The `cancel(id)` method SHALL abort the specified subagent's current turn via `AbortController.abort()`.

#### Scenario: Cancel running subagent

- **WHEN** `cancel("abc123")` is called
- **THEN** subagent "abc123" SHALL have its abort signal triggered
- **AND** its status SHALL be updated to cancelled

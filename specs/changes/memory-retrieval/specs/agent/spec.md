# agent

## MODIFIED Requirements

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include four memory tool definitions in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller:

1. `memory_read` — read the active scope, user.md, or any allowed cross-scope memory.
2. `memory_read_index` — list available topic and named-agent persona scopes with descriptions.
3. `memory_search` — search curated memory entries lexically and return ranked matches.
4. `memory_write` — mutate the active scope only.

The `memory_write` tool's `target` parameter SHALL be wired to resolve to a scope based on the runner's `(chatId, topicId)` or named-agent identity. The agent MUST NOT be given the ability to supply an arbitrary scope on writes. The `memory_search` tool SHALL use the same active scope and chat boundary as `memory_read_index` unless `all_chats` is explicitly requested. Persona scope eligibility for `memory_search` SHALL match the `memory_read_index` `agents` gating: the main goblin agent searches all persona scopes; a named subagent searches only its own persona scope; anonymous subagents search none.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `memory_read`, `memory_read_index`, `memory_search`, and `memory_write`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `topics/-100123/42/memory.md`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, plus the four memory tools

#### Scenario: Search tool uses active chat boundary

- **WHEN** a topic-bound runner exposes `memory_search`
- **THEN** a default search SHALL be limited to the runner's active chat plus global user/general memory

#### Scenario: Main agent searches all persona scopes

- **WHEN** the main goblin agent's runner exposes `memory_search`
- **THEN** default search SHALL include every `agents/<name>/memory.md` persona scope

#### Scenario: Named subagent searches own persona only

- **WHEN** a named subagent `researcher` exposes `memory_search`
- **THEN** default search SHALL include `agents/researcher/memory.md` and SHALL NOT include other persona scopes

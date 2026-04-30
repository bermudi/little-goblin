# agent

## MODIFIED Requirements

### Requirement: AgentRunner injects memory snapshot as per-turn aside

The `AgentRunner` SHALL build a per-turn snapshot from the active memory scope (resolved from the runner's `(chatId, topicId)` or named-agent identity), the global `user.md`, and the cross-scope index, and inject it into the next turn via `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })` before each `prompt()` call. The snapshot MUST be loaded fresh for every turn so that writes performed in earlier turns become visible on subsequent turns. The snapshot MUST NOT be added to pi's `_baseSystemPrompt`; whatever value `_baseSystemPrompt` holds at AgentSession creation MUST remain unchanged across turns by this change.

#### Scenario: First turn in a topic loads scoped snapshot

- **WHEN** `prompt()` is called for the first time on an `AgentRunner` bound to topic `42` in chat `-100123`
- **THEN** the runner SHALL read `topics/-100123/42/memory.md`, `user.md`, and the cross-scope index from disk
- **AND** dispatch the formatted snapshot via `sendCustomMessage(..., { deliverAs: "nextTurn" })` before invoking the underlying prompt

#### Scenario: First turn in a DM loads general snapshot

- **WHEN** `prompt()` is called for the first time on an `AgentRunner` bound to a DM chat
- **THEN** the runner SHALL read `general/memory.md`, `user.md`, and the cross-scope index from disk
- **AND** the snapshot's `## scope` section SHALL identify the active scope as `General`

#### Scenario: Subsequent turn after a memory write in the active scope

- **WHEN** the agent calls `memory_write` during turn N from a topic-bound session
- **AND** the user sends a new message that triggers turn N+1 in the same topic
- **THEN** the snapshot loaded for turn N+1 SHALL include the entry written during turn N

#### Scenario: Cross-topic write does not affect this scope's snapshot

- **WHEN** topic `7`'s `memory.md` changes between turn N and turn N+1 of a session in topic `42`
- **THEN** the snapshot for turn N+1 in topic `42` SHALL include topic `7` in the `## other scopes` index with its updated description (if any)
- **AND** topic `7`'s entries SHALL NOT appear in the active `## memory.md` section

#### Scenario: System prompt unchanged across turns

- **WHEN** any memory file changes on disk between turns
- **THEN** `agent.state.systemPrompt` between turns SHALL remain equal to the value `_baseSystemPrompt` held at AgentSession creation

#### Scenario: All scopes empty

- **WHEN** `user.md`, the active scope's `memory.md`, and every other scope are empty or absent
- **THEN** the runner MAY skip the `sendCustomMessage` call
- **AND** the prompt SHALL proceed without an aside

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include three tool definitions in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller (the requirement name is preserved from the prior `memory`-singular tool for canon continuity; the tool surface is now three distinct definitions):

1. `memory_read` — read the active scope, user.md, or any cross-scope memory.
2. `memory_read_index` — list available topic and named-agent persona scopes with descriptions.
3. `memory_write` — mutate the active scope only.

The `memory_write` tool's `target` parameter SHALL be wired to resolve to a scope based on the runner's `(chatId, topicId)` (or named-agent identity for `target: "agent"`). The agent MUST NOT be given the ability to supply an arbitrary scope on writes.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `memory_read`, `memory_read_index`, and `memory_write`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `topics/-100123/42/memory.md`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, plus the three memory tools

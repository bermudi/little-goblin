# agent

## ADDED Requirements

### Requirement: AgentRunner schedules background memory reflection after completed turns

After a main-agent turn reaches `agent_end`, the `AgentRunner` SHALL schedule a non-blocking memory reflection pass for that session. Reflection MUST NOT delay Telegram response flushing, MUST NOT run for `followUp()` events independently, and MUST NOT start while the turn is still streaming.

#### Scenario: Completed prompt schedules reflection

- **WHEN** a main-agent prompt turn emits `agent_end`
- **THEN** the runner SHALL schedule a background reflection pass for that session and active scope
- **AND** user-visible turn completion SHALL not wait for the reflection result

#### Scenario: Mid-turn steer does not schedule independent reflection

- **WHEN** `followUp()` steers a running turn
- **THEN** no separate reflection pass SHALL be scheduled for the follow-up itself
- **AND** the completed combined turn SHALL be eligible for one reflection pass at `agent_end`

### Requirement: Reflection cursor prevents duplicate processing

The memory reflection system SHALL persist a cursor under the session directory that records which transcript entries have been reflected. A reflection pass SHALL process only transcript entries after the cursor, and SHALL advance the cursor only after candidate extraction, safety filtering, and persistence/quarantine complete without an unrecoverable error.

When reflection first observes an existing session with no cursor file, it SHALL seed the cursor to the then-current end of `transcript.jsonl` before later completed turns are reflected, and SHALL NOT process historical transcript entries from before that observation. This preserves the no-automatic-backfill rollout contract; historical transcript import requires a separate explicit backfill command outside this change.

Reflection passes for the same session MUST be serialized in-process. If a second reflection schedule arrives while one is already running for that session, the system SHALL coalesce it into at most one follow-up pass after the current pass completes rather than running two passes against the same cursor concurrently.

#### Scenario: Existing session seeds cursor before future reflection

- **GIVEN** a session already has `transcript.jsonl` entries and no `memory-reflection.json`
- **WHEN** the runner or reflection system first observes that session after this feature is enabled
- **THEN** the reflection system SHALL write a cursor at the current transcript end
- **AND** it SHALL NOT extract candidates from the pre-existing transcript entries
- **AND** a later completed turn in the same session SHALL be eligible for reflection because it occurs after the seeded cursor

#### Scenario: First observation of new session reflects future turns only

- **GIVEN** a newly-created session has no reflection cursor
- **WHEN** reflection first observes it after a completed turn
- **THEN** that completed turn MAY be considered new work and reflected
- **AND** later passes SHALL process only entries after the cursor

#### Scenario: Overlapping schedules coalesce per session

- **WHEN** a reflection pass is already running for session `s1`
- **AND** another turn completion schedules reflection for `s1`
- **THEN** the second schedule SHALL NOT start a concurrent pass with the same cursor
- **AND** the system SHALL run at most one follow-up pass for `s1` after the current pass completes

#### Scenario: Restart after successful reflection

- **WHEN** a turn has already been reflected and Goblin restarts
- **THEN** the next reflection pass for that session SHALL skip the already-reflected transcript entries

#### Scenario: Failed reflection retries same range

- **WHEN** reflection fails before advancing the cursor
- **THEN** a later reflection pass SHALL retry the same transcript range

### Requirement: Reflection uses scoped memory context

The reflection pass SHALL resolve the same active memory scope as the user-facing turn and SHALL consider the current `user.md`, active `memory.md`, and cross-scope descriptions when deciding where and whether to persist candidates. Automatic reflection writes SHALL target only `user.md` or the active main-agent memory scope.

#### Scenario: Topic turn reflects into topic scope

- **WHEN** a completed turn occurred in topic `42`
- **THEN** automatic project/session facts from that turn SHALL be considered for `topics/<chat>/42/memory.md`
- **AND** stable user preferences SHALL be considered for `user.md`
- **AND** no other topic scope SHALL be written automatically

#### Scenario: General turn reflects into general scope

- **WHEN** a completed turn occurred in a DM or supergroup without topic
- **THEN** automatic non-user facts SHALL target `general/memory.md`

## MODIFIED Requirements

### Requirement: AgentRunner injects memory snapshot as per-turn aside

The `AgentRunner` SHALL build a per-turn snapshot from the active memory scope (resolved from the runner's `(chatId, topicId)` or named-agent identity), the global `user.md`, and the cross-scope index, and inject it into the next turn via `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })` before each `prompt()` call. The snapshot MUST be loaded fresh for every turn so that writes performed in earlier turns or by completed reflection passes become visible on subsequent turns. The snapshot MUST NOT be added to pi's `_baseSystemPrompt`; whatever value `_baseSystemPrompt` holds at AgentSession creation MUST remain unchanged across turns by this change.

#### Scenario: Subsequent turn after reflection write

- **WHEN** background reflection writes a memory entry after turn N completes
- **AND** the user sends a new message that triggers turn N+1 in the same scope
- **THEN** the snapshot loaded for turn N+1 SHALL include the reflected entry

#### Scenario: System prompt unchanged across reflection writes

- **WHEN** any reflection pass changes memory files on disk between turns
- **THEN** `agent.state.systemPrompt` between turns SHALL remain equal to the value `_baseSystemPrompt` held at AgentSession creation

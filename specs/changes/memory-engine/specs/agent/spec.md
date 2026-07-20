# agent

## MODIFIED Requirements

### Requirement: AgentRunner schedules background memory reflection after completed turns

After a main-agent turn reaches `agent_end`, the `AgentRunner` SHALL advance the reflection cursor for that session to the current transcript end. It SHALL NOT schedule a non-blocking memory reflection pass. Reflection MUST NOT delay Telegram response flushing, MUST NOT run for `followUp()` events independently, and MUST NOT start while the turn is still streaming.

The per-turn reflection pass is replaced by the dreaming pipeline's light sleep phase, which SHALL run on a configurable interval (default 4 hours) via the scheduler. The `AgentRunner` SHALL continue to advance the reflection cursor after `agent_end` so that light sleep knows which transcript entries are new.

#### Scenario: Completed prompt advances cursor

- **WHEN** a main-agent prompt turn emits `agent_end`
- **THEN** the runner SHALL advance the reflection cursor for that session to the current transcript end
- **AND** user-visible turn completion SHALL not wait for any reflection work
- **AND** no per-turn reflection pass SHALL be scheduled

### Requirement: AgentRunner injects memory snapshot as per-turn aside

The `AgentRunner` SHALL build a bounded frozen memory summary at session creation and append it to `_baseSystemPrompt`. The frozen summary SHALL include the active scope description, a bounded `user.md` summary, a bounded active scope `memory.md` summary, and a cross-scope index, bounded to 1200 characters total. The frozen summary SHALL NOT be refreshed mid-session.

The `AgentRunner` SHALL NOT inject the full `[goblin memory snapshot]` per-turn aside. Instead, before each `prompt()` call it SHALL compute a `## relevant memory` section via hybrid search on the current prompt text and inject it via `sendCustomMessage(..., { deliverAs: "nextTurn" })`. The `## relevant memory` section SHALL be bounded to 3 results by default and clamped to a maximum of 5.

#### Scenario: Session creation injects frozen summary into system prompt

- **WHEN** `AgentRunner` creates a new `AgentSession`
- **THEN** `_baseSystemPrompt` SHALL include the frozen memory summary
- **AND** the frozen summary SHALL remain unchanged for the lifetime of the session

#### Scenario: Per-turn prompt injects relevant memory, not full snapshot

- **WHEN** a new user turn is dispatched via `prompt()`
- **THEN** `sendCustomMessage` SHALL be called with a `## relevant memory` section computed from the prompt text
- **AND** the message SHALL be delivered as `nextTurn`
- **AND** the full `[goblin memory snapshot]` SHALL NOT be injected

#### Scenario: Mid-turn steer does not advance cursor independently

- **WHEN** `followUp()` steers a running turn
- **THEN** the cursor SHALL not advance until the combined turn reaches `agent_end`
- **AND** the completed combined turn SHALL advance the cursor once

### Requirement: Reflection cursor prevents duplicate processing

The dreaming pipeline SHALL persist a cursor at `$GOBLIN_HOME/state/sessions/<id>/memory-dreaming-cursor.json` that records which transcript entries have been processed by light sleep. The cursor format SHALL be a line offset into `transcript.jsonl`. A light sleep pass SHALL process only transcript entries after the cursor, and SHALL advance the cursor only after candidate extraction, safety filtering, and persistence/quarantine complete without an unrecoverable error.

When light sleep first observes an existing session with no `memory-dreaming-cursor.json` file, it SHALL seed the cursor to the then-current end of `transcript.jsonl` before later completed turns are processed, and SHALL NOT process historical transcript entries from before that observation. This preserves the no-automatic-backfill rollout contract; historical transcript import requires a separate explicit backfill command outside this change.

The existing `memory-reflection.json` cursor SHALL be migrated to `memory-dreaming-cursor.json` on first observation: the cursor value (line offset) SHALL be preserved, the new file SHALL be written, and the old `memory-reflection.json` file SHALL be removed. Dreaming passes for the same session MUST be serialized in-process.

The `AgentRunner` SHALL advance the cursor after `agent_end` (marking transcript entries as eligible for the next light sleep pass). Light sleep SHALL advance the cursor again after processing (marking entries as consumed).

#### Scenario: Existing session seeds cursor before future light sleep

- **GIVEN** a session already has `transcript.jsonl` entries and no `memory-reflection.json`
- **WHEN** light sleep first observes that session after this feature is enabled
- **THEN** light sleep SHALL write a cursor at the current transcript end
- **AND** SHALL NOT extract candidates from the pre-existing transcript entries
- **AND** a later completed turn in the same session SHALL be eligible for light sleep because it occurs after the seeded cursor

#### Scenario: Existing memory-reflection.json cursor is migrated to dreaming cursor

- **GIVEN** a session already has a `memory-reflection.json` cursor at line 200 from the previous reflection system
- **WHEN** light sleep first observes that session after this feature is enabled
- **THEN** the existing cursor value SHALL be migrated to the dreaming cursor format (same line offset)
- **AND** light sleep SHALL process entries starting from line 201
- **AND** the `memory-reflection.json` file SHALL be removed or superseded by the dreaming cursor file

#### Scenario: Cursor advances after successful light sleep

- **WHEN** light sleep processes transcript entries 100-150 and all candidates are persisted or quarantined
- **THEN** the cursor SHALL advance to line 150
- **AND** the next light sleep pass SHALL start from line 151

#### Scenario: Failed light sleep retries same range

- **WHEN** light sleep fails before advancing the cursor
- **THEN** a later light sleep pass SHALL retry the same transcript range

#### Scenario: AgentRunner advances cursor on agent_end

- **WHEN** a main-agent turn reaches `agent_end` and the transcript has grown to line 200
- **THEN** the cursor SHALL be advanced to line 200
- **AND** the next light sleep pass SHALL process entries from the previous cursor position to line 200

### Requirement: Reflection uses scoped memory context

The dreaming pipeline SHALL resolve the same active memory scope as the user-facing turn. The dreaming session (`__goblin_dreaming__`, `chatId: 0`) is the dispatch vehicle for model turns, NOT the promotion target — its `ActiveScope` (`{ chatId: 0, topicScope: "general" }`) is never written to. Light sleep SHALL target the **originating transcript's** session active scope for promotions (e.g. a transcript snippet from session bound to topic 42 promotes into `topics/<chatId>/42`). REM and deep sleep SHALL aggregate across all scopes but promote each theme or short-term entry into the scope that originated it most frequently. The promotion rule is: for each theme or entry, collect its origin sessions; choose the scope with the highest session count; break ties by the most recent `updated_at`, then by scope name ascending. If the origin sessions are all from transcript scopes without a clear curated target, promote to `general`.

#### Scenario: Topic turn dreaming promotes into topic scope

- **WHEN** light sleep processes a transcript from a session in topic `42`
- **THEN** promoted entries SHALL be inserted with `scope = "topics/<chatId>/42"` and `entry_kind = "memory"`

#### Scenario: General turn dreaming promotes into general scope

- **WHEN** light sleep processes a transcript from a DM or supergroup-without-topic session
- **THEN** promoted entries SHALL be inserted with `scope = "general"` and `entry_kind = "memory"`

#### Scenario: REM sleep promotes a recurring theme to its dominant scope

- **GIVEN** the concept tag "backup" appears in transcript entries from sessions scoped to `topics/-100123/7` in 3 sessions and in `topics/-100123/11` in 1 session
- **WHEN** REM sleep detects "backup" as a recurring theme
- **THEN** the theme SHALL be promoted to `scope = "topics/-100123/7"` because it originated there most frequently

### Requirement: AgentRunner registers the memory write tool

The `AgentRunner` SHALL include two memory tool definitions in the `customTools` it passes to `createAgentSession`, in addition to any tools provided by the caller:

1. `memory_search` — hybrid search over memory entries and transcript chunks. Subsumes the former `memory_read` (query omitted + scope provided → return entries) and `memory_read_index` (query omitted + scope omitted → return index).
2. `memory_write` — mutate the active scope only.

The `memory_read` and `memory_read_index` tools SHALL be removed. The `memory_write` tool's `target` parameter SHALL be wired to resolve to a `(scope, entry_kind)` pair based on the runner's `(chatId, topicId)` or named-agent identity. The agent MUST NOT be given the ability to supply an arbitrary scope on writes. The `memory_search` tool SHALL use the same active scope and chat boundary as the former `memory_read_index` unless `all_chats` is explicitly requested. Persona scope eligibility for `memory_search` SHALL match the former `memory_read_index` `agents` gating: the main goblin agent searches all persona scopes; a named subagent searches only its own persona scope; anonymous subagents search none.

#### Scenario: Runner constructed for a topic

- **WHEN** `AgentRunner` is constructed for a session bound to topic `42` in chat `-100123`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `memory_search` and `memory_write`
- **AND** SHALL NOT include `memory_read` or `memory_read_index`
- **AND** the `memory_write` tool's invocation handler SHALL resolve `target = "memory"` to `scope = "topics/-100123/42"`, `entry_kind = "memory"`

#### Scenario: Caller-supplied tools preserved

- **WHEN** `AgentRunner` is constructed with `customTools = [t1, t2]`
- **THEN** the `customTools` array passed to `createAgentSession` SHALL include `t1`, `t2`, plus `memory_search` and `memory_write`

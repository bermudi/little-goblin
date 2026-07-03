# subagents

## ADDED Requirements

### Requirement: Background reflection excludes subagent transcripts

The automatic memory reflection pipeline SHALL run only for main `AgentRunner` sessions. Subagent transcripts SHALL NOT be reflected automatically by this change, even though subagents may continue to use explicit memory tools.

#### Scenario: Subagent completes without reflection

- **WHEN** a subagent emits `agent_end`
- **THEN** no background reflection pass SHALL be scheduled for the subagent session
- **AND** any memory changes from that subagent SHALL come only from explicit `memory_write` tool calls

#### Scenario: Named subagent persona remains explicit

- **WHEN** a named subagent completes a turn without calling `memory_write({target: "agent", ...})`
- **THEN** `agents/<name>/memory.md` SHALL NOT be modified by automatic reflection

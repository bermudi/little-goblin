# subagents

## ADDED Requirements

### Requirement: Generic subagents filter deployment prompt files from context discovery

A generic subagent's `DefaultResourceLoader` SHALL receive an `agentsFilesOverride` that filters the resolved paths of `$GOBLIN_HOME/workspace/SOUL.md`, `$GOBLIN_HOME/workspace/AGENTS.md`, and `$GOBLIN_HOME/workspace/HEARTBEAT.md` out of any pi-discovered `agentsFiles` list while leaving other discovered context files (e.g., a project `AGENTS.md`) intact. Named subagents are unaffected because they use `noContextFiles: true` and their own `AGENTS.md` as the system prompt.

#### Scenario: Generic subagent does not inherit workspace SOUL/AGENTS/HEARTBEAT

- **WHEN** a generic subagent is spawned and pi's default context discovery would surface `$GOBLIN_HOME/workspace/SOUL.md`, `AGENTS.md`, or `HEARTBEAT.md`
- **THEN** the `agentsFilesOverride` SHALL remove those three resolved paths from the discovered set
- **AND** the generic subagent SHALL NOT receive their contents as context

#### Scenario: Project AGENTS.md is preserved for generic subagents

- **WHEN** a generic subagent is spawned under a project execution environment whose project `AGENTS.md` is discovered
- **THEN** the `agentsFilesOverride` SHALL NOT remove the project `AGENTS.md`
- **AND** that file SHALL remain available as context

#### Scenario: Named subagents are unaffected

- **WHEN** a named subagent is spawned
- **THEN** its loader SHALL continue to use `noContextFiles: true` with its own `AGENTS.md` as the system prompt
- **AND** no `agentsFilesOverride` filtering SHALL be required for the named path

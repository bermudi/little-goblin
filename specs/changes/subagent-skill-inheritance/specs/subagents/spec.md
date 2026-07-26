# subagents

## MODIFIED Requirements

### Requirement: Generic subagents inherit parent skills

A generic subagent SHALL inherit the parent runtime's frozen resolved skill manifest, including exact selected skill files and source provenance. It MUST NOT rerun host, environment, or ancestor discovery independently, and recursive generic spawns SHALL inherit the manifest they received. A missing inherited file at spawn time SHALL fail visibly rather than silently broaden discovery.

#### Scenario: Generic spawn inherits selected set

- **WHEN** a parent with Goblin skill `memory-browser` and environment skill `youtube-transcript` spawns a generic subagent
- **THEN** the subagent SHALL receive exactly those selected skill files
- **AND** SHALL not gain other skills present in any catalog

#### Scenario: Parent excludes host

- **WHEN** the parent policy excludes host skills
- **THEN** the generic subagent SHALL not inspect or load `~/.agents/skills/`

#### Scenario: Recursive inheritance

- **WHEN** a generic subagent spawns another generic subagent
- **THEN** the child SHALL inherit the same frozen manifest

### Requirement: Named subagents load isolated definitions

Named subagents SHALL load their `AGENTS.md` and pi-native skill catalog from `$GOBLIN_HOME/workspace/agents/<name>/.agents/skills/`. They SHALL NOT inherit the caller's resolved manifest by default. Startup/use-time migration SHALL atomically rename a legacy definition `skills/` directory when the canonical destination is absent and MUST fail on a populated collision.

#### Scenario: Named agent remains isolated

- **WHEN** named agent `researcher` is spawned
- **THEN** its skills SHALL come only from `workspace/agents/researcher/.agents/skills/`
- **AND** Goblin, environment, host, and caller-selected skills SHALL not be inherited

#### Scenario: Legacy named catalog migrates

- **GIVEN** `workspace/agents/researcher/skills/` exists and its `.agents/skills/` destination is absent
- **WHEN** the definition is loaded
- **THEN** the legacy tree SHALL be atomically renamed to the canonical path

#### Scenario: Named catalog conflict

- **WHEN** both legacy and canonical named-agent catalogs contain entries
- **THEN** loading SHALL fail with both paths and change neither

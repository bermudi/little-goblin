# agent

## ADDED Requirements

### Requirement: Skill catalogs resolve through explicit source authority

The agent module SHALL expose a `SkillCatalogResolver` that resolves a frozen skill set from an immutable Execution Environment and a validated policy with `goblin`, `environment`, and `host` source selections. Each selection SHALL be `all`, `none`, or `selected` with unique Agent Skill names.

The resolver SHALL inspect only these exact roots: `$GOBLIN_HOME/.agents/skills/` for `goblin`; `$GOBLIN_HOME/workspace/.agents/skills/` for a personal environment; `<projectRoot>/.agents/skills/` and `<projectRoot>/.pi/skills/` for a project environment; and `~/.agents/skills/` for `host`. It MUST NOT walk above `projectRoot`, inspect `~/.pi/agent/skills/`, or enable package skill discovery. It SHALL use pi's skill loader for parsing/validation and return source/path provenance plus diagnostics.

#### Scenario: Default personal resolution

- **GIVEN** the default policy of Goblin all, environment all, host none
- **WHEN** a personal runtime resolves skills
- **THEN** it SHALL include skills from `$GOBLIN_HOME/.agents/skills/` and `$GOBLIN_HOME/workspace/.agents/skills/`
- **AND** SHALL exclude `~/.agents/skills/`

#### Scenario: Default project resolution

- **WHEN** a project runtime at `/srv/project-a` resolves the default policy
- **THEN** it SHALL include Goblin skills and exact `/srv/project-a/.agents/skills/` and `/srv/project-a/.pi/skills/`
- **AND** SHALL NOT load skills from parent directories

#### Scenario: Selected source

- **WHEN** a source policy selects skills `alpha` and `beta`
- **THEN** only those names from that source SHALL be returned
- **AND** a missing selected name SHALL fail resolution naming the source and name

#### Scenario: Same file reached twice

- **WHEN** two configured roots resolve to the same canonical skill file
- **THEN** the resolver SHALL include it once

#### Scenario: Distinct duplicate names

- **WHEN** selected distinct files declare the same skill name
- **THEN** resolution SHALL fail with the name, sources, and both paths
- **AND** SHALL NOT choose a winner by discovery order

### Requirement: Resolved skills are observable runtime input

Every main runtime SHALL log its source modes, resolved skill names, source-qualified paths, and non-fatal diagnostics at creation without logging skill bodies. Resolution failure SHALL identify the Conversation, environment kind, and affected sources before runner creation fails.

#### Scenario: Runtime skill log

- **WHEN** a runner initializes successfully
- **THEN** structured logs SHALL permit the operator to determine exactly which skills were available and from which source

#### Scenario: Invalid catalog

- **WHEN** pi rejects or warns about a malformed skill
- **THEN** the diagnostic SHALL be preserved with its source/path
- **AND** missing-description skills SHALL not appear as available

## MODIFIED Requirements

### Requirement: Main agent skill discovery is configurable

Main-agent skill availability SHALL come exclusively from `SkillCatalogResolver`, not the removed process-wide `skillSources` field or pi ambient discovery. Until Surface policy is introduced, every main runtime SHALL use Goblin `all`, environment `all`, host `none`. `DefaultResourceLoader` SHALL receive `noSkills: true` and only the selected skill paths as explicit additional paths. Context-file discovery SHALL remain independently disabled.

#### Scenario: Explicit loader construction

- **WHEN** AgentRunner initializes
- **THEN** its loader SHALL have ambient skill discovery disabled
- **AND** SHALL receive only paths from the frozen resolved set

#### Scenario: Host skill is not ambient

- **GIVEN** `~/.agents/skills/private/SKILL.md` exists
- **WHEN** the default policy resolves
- **THEN** that skill SHALL not be loaded

# sessions

## ADDED Requirements

### Requirement: Skill policy is Surface-owned

Surface settings SHALL persist independent `goblin`, `environment`, and `host` `SourceSelection` values, each exactly `all`, `none`, or `selected` with a non-empty unique list of valid Agent Skill names. Absence of a stored policy SHALL mean Goblin all, environment all, host none without an eager write. Policy SHALL survive Conversation rotation, resume movement, archive, and temporary unbinding.

#### Scenario: Default policy

- **WHEN** a Surface has no stored skill policy
- **THEN** effective policy SHALL enable all Goblin and environment skills
- **AND** disable host skills

#### Scenario: Independent shared-project policies

- **GIVEN** two Surfaces share canonical project root `/srv/project-a`
- **WHEN** one disables Goblin skills
- **THEN** the other Surface's policy SHALL remain unchanged

#### Scenario: Policy survives new

- **WHEN** `/new` rotates the bound Conversation
- **THEN** the Surface's effective skill policy SHALL remain unchanged

## MODIFIED Requirements

### Requirement: Surface settings are keyed by SurfaceId

`state/topic-settings.json` SHALL use canonical SurfaceId keys for project assignment, model/thinking preferences introduced by dependent lifecycle work, and skill policy. Skill policy writes SHALL atomically replace the complete validated selection for one Surface and MUST NOT mutate another Surface sharing the same environment.

#### Scenario: Persist selected skills

- **WHEN** a Surface stores environment `selected: ["youtube-transcript"]`
- **THEN** the canonical SurfaceId record SHALL retain exactly that selection across restart

#### Scenario: Invalid selection is rejected

- **WHEN** a policy contains duplicate/invalid names, an empty selected list, or an unknown mode
- **THEN** boundary validation SHALL fail without changing settings

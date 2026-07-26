# agent-runner-project-dir

## MODIFIED Requirements

### Requirement: AgentRunner derives project authority from the session environment

`AgentRunner` SHALL be constructed from the Conversation's persisted Execution Environment. Personal runtime CWD SHALL be `$GOBLIN_HOME/workspace`; project runtime CWD SHALL be canonical `projectRoot`. Project guidance, project-bound tools, attachment authority, and the environment skill catalog MUST derive from that value rather than mutable Surface path data.

Skill roots are a separate policy input resolved under the same authority: personal environment skills come only from `$GOBLIN_HOME/workspace/.agents/skills/`; project environment skills come only from exact `<projectRoot>/.agents/skills/` and `<projectRoot>/.pi/skills/`. Goblin and host catalogs do not become project roots. Pi `agentDir` and model/auth configuration SHALL remain `$GOBLIN_HOME/state/pi`.

#### Scenario: Personal runner authority

- **WHEN** a personal Conversation initializes
- **THEN** its CWD SHALL be `$GOBLIN_HOME/workspace`
- **AND** its environment skill root SHALL be `$GOBLIN_HOME/workspace/.agents/skills/`

#### Scenario: Project runner authority

- **WHEN** a Conversation for `/srv/project-a` initializes
- **THEN** its CWD, project guidance, project tools, and project skill roots SHALL derive from `/srv/project-a`
- **AND** environment skill discovery SHALL not walk to `/srv/.agents/skills/`

#### Scenario: Surface mismatch fails first

- **WHEN** Surface and Conversation environments differ
- **THEN** runner creation SHALL fail before resolving skill catalogs or constructing project-bound effects

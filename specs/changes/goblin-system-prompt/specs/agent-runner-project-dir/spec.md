# agent-runner-project-dir

## ADDED Requirements

### Requirement: Project AGENTS is exact project guidance

When a main Goblin session is bound to a project directory, only the exact file `projectDir/AGENTS.md` SHALL be eligible as project guidance. Goblin MUST NOT walk ancestors, load compatibility files, or load global instruction files for project guidance.

#### Scenario: Bound project has AGENTS

- **WHEN** a session is bound to a project directory containing `AGENTS.md`
- **THEN** the constructed system prompt SHALL include that exact file as project-specific guidance
- **AND** the prompt SHALL positively scope it to project files, commands, tests, and conventions

#### Scenario: Bound project lacks AGENTS

- **WHEN** a session is bound to a project directory without `AGENTS.md`
- **THEN** prompt construction SHALL proceed without project guidance

### Requirement: Project AGENTS does not replace deployment voice

Project guidance SHALL supplement the deployed Goblin prompt. It MUST NOT replace `$GOBLIN_HOME/SOUL.md` or become the deployed conversational identity.

#### Scenario: Project and SOUL both exist

- **WHEN** both `$GOBLIN_HOME/SOUL.md` and `projectDir/AGENTS.md` exist
- **THEN** the constructed system prompt SHALL include both sections
- **AND** section scoping SHALL define project guidance as repository/workspace instructions rather than deployment voice

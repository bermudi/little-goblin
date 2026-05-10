# pi-host

## ADDED Requirements

### Requirement: Pi-host exposes Goblin prompt file paths

The `src/pi-host.ts` module SHALL expose canonical path helpers for Goblin-owned prompt files under `$GOBLIN_HOME`, including `agentsMdPath(home)` and `soulMdPath(home)`.

#### Scenario: Prompt path helpers available

- **WHEN** a consumer imports Goblin prompt path helpers from `src/pi-host.ts`
- **THEN** `agentsMdPath(home)` SHALL resolve to `$GOBLIN_HOME/AGENTS.md`
- **AND** `soulMdPath(home)` SHALL resolve to `$GOBLIN_HOME/SOUL.md`

### Requirement: Prompt file reads fail loud except optional missing files

Goblin prompt file loading SHALL fail when required files are missing or unreadable. Missing optional files SHALL be treated as absent. Non-`ENOENT` filesystem errors MUST propagate for every prompt-owned input, including optional deployment AGENTS and optional project guidance.

#### Scenario: Required SOUL missing

- **WHEN** `$GOBLIN_HOME/SOUL.md` does not exist
- **THEN** prompt construction SHALL fail

#### Scenario: Optional AGENTS missing

- **WHEN** `$GOBLIN_HOME/AGENTS.md` does not exist
- **THEN** prompt construction SHALL continue without that file

#### Scenario: Optional project AGENTS missing

- **WHEN** a session is bound to a project directory whose exact `AGENTS.md` does not exist
- **THEN** prompt construction SHALL continue without project guidance

#### Scenario: Prompt file unreadable

- **WHEN** a prompt file exists but cannot be read for a reason other than `ENOENT`
- **THEN** prompt construction SHALL fail

### Requirement: Prompt validation uses a shared error contract

Startup preflight and the main `AgentRunner` prompt-construction path SHALL use the same prompt-file validation semantics for required `SOUL.md`. Missing `SOUL.md` SHALL produce an actionable configuration error that tells the operator to run onboarding or create `SOUL.md`.

#### Scenario: Startup and runner share missing SOUL semantics

- **WHEN** `$GOBLIN_HOME/SOUL.md` is missing
- **THEN** startup preflight and main runner prompt construction SHALL both report the missing required prompt file as a configuration error
- **AND** both paths SHALL include guidance to run onboarding or create `SOUL.md`

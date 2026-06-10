# pi-host

## Requirements

### Requirement: Pi-host module provides shared pi service construction

The `src/pi-host.ts` module SHALL export a `PiServices` type and a `createPiServices(home: string): PiServices` function that returns `{ authStorage: AuthStorage, modelRegistry: ModelRegistry, settingsManager: SettingsManager }` configured to use `$GOBLIN_HOME/goblin/` as the pi configuration directory.

#### Scenario: Services created with correct paths

- **WHEN** `createPiServices("/home/user/goblin")` is called
- **THEN** the returned `authStorage` SHALL point at `/home/user/goblin/goblin/auth.json`
- **AND** the returned `modelRegistry` SHALL point at `/home/user/goblin/goblin/models.json`
- **AND** the returned `settingsManager` SHALL be an in-memory instance with empty defaults

#### Scenario: Idempotent — same home, same result

- **WHEN** `createPiServices(home)` is called twice with the same `home`
- **THEN** each call SHALL return new, independent service instances (no internal caching)

### Requirement: Pi-host module exports pi filesystem path helpers

The `src/pi-host.ts` module SHALL export path helper functions `workdirPath(home)`, `piAgentDir(home)`, and `agentsMdPath(home)` as the canonical source for pi-related filesystem paths.

#### Scenario: Path helpers available

- **WHEN** a consumer imports `{ workdirPath, piAgentDir, agentsMdPath }` from `pi-host.ts`
- **THEN** each SHALL return the same paths previously defined in `src/agent/paths.ts`

### Requirement: Pi-host module has no dependency on agent or subagent modules

The `src/pi-host.ts` module MUST NOT import from `src/agent/` or `src/subagents/`. It SHALL depend only on `@mariozechner/pi-coding-agent` types and `node:path`.

#### Scenario: Import check

- **WHEN** the TypeScript project is compiled
- **THEN** `src/pi-host.ts` SHALL NOT have any import path starting with `../agent/` or `../subagents/`

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

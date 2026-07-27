# Capability: AgentRunner Project Directory Support

## ADDED Requirements

### Requirement: AgentRunner derives project authority from the session environment

`AgentRunner` SHALL be constructed from the session's persisted `ExecutionEnvironment`, not from an optional Surface `projectDir`. For a personal environment it SHALL use the persistent `$GOBLIN_HOME/workspace` as `cwd` and load no project guidance or project-bound tools. For a project environment it SHALL use the canonical `projectRoot` as `cwd`, as the root for exact project guidance and project skill discovery, and as the trusted directory supplied to project-bound tools and file handling.

The pi `agentDir` and model/auth configuration SHALL remain deployment-owned under `$GOBLIN_HOME/state/pi`. This change SHALL preserve the currently implemented Goblin-wide skill catalog path and loading behavior; native skill layout and Surface policy belong to later changes. A project environment MUST supplement rather than replace those deployment resources.

#### Scenario: Personal session initializes

- **WHEN** an AgentRunner is created for a session with `executionEnvironment: { kind: "personal" }`
- **AND** it initializes
- **THEN** its `cwd` SHALL be `$GOBLIN_HOME/workspace`
- **AND** its pi `agentDir` SHALL remain `$GOBLIN_HOME/state/pi`
- **AND** no project `AGENTS.md`, project skills, external-agent tool, or project file destination SHALL be enabled
- **AND** it SHALL NOT fall back to a legacy `scratch/workdir`

#### Scenario: Project session initializes

- **WHEN** an AgentRunner is created for a session with project root `/srv/project-a`
- **AND** it initializes
- **THEN** its `cwd` SHALL be `/srv/project-a`
- **AND** its pi `agentDir` SHALL remain `$GOBLIN_HOME/state/pi`
- **AND** project guidance and skill discovery SHALL be rooted at `/srv/project-a`
- **AND** project-bound tools and file destinations SHALL receive `/srv/project-a` from the session environment

#### Scenario: Surface setting changes cannot change a live session

- **GIVEN** a session persists the personal execution environment
- **WHEN** a caller attempts to create its runner using a Surface's project assignment
- **THEN** runner creation SHALL be rejected as an environment mismatch
- **AND** the session SHALL NOT initialize under the project root

### Requirement: Runner creation requires Surface and session environment agreement

Before creating or returning a runner for a Telegram turn, the dispatcher SHALL compare the session's persisted execution environment with the addressed Surface's effective execution environment. They MUST be equal. A mismatch SHALL fail loudly before pi initialization, project file writes, project guidance reads, skill discovery, or project-bound tool construction. Internal sessions are exempt from Surface comparison and SHALL use their persisted personal environment.

#### Scenario: Matching project environment creates runner

- **GIVEN** a Surface and its bound session both identify canonical project root `/srv/project-a`
- **WHEN** the dispatcher creates a runner
- **THEN** runner creation SHALL proceed using `/srv/project-a`

#### Scenario: Mismatch is rejected before side effects

- **GIVEN** a Surface identifies `/srv/project-b`
- **AND** its bound session identifies `/srv/project-a`
- **WHEN** a Telegram message or scheduled turn requests a runner
- **THEN** the dispatcher SHALL reject the mismatch and log both environment identities
- **AND** SHALL NOT initialize pi, save an attachment, load project guidance, or construct project-bound tools

#### Scenario: Internal personal runner

- **GIVEN** an internal session persists the personal environment and has no Surface
- **WHEN** its runner is created
- **THEN** it SHALL initialize with `$GOBLIN_HOME/workspace` without Surface comparison

### Requirement: Pi history reopens only under a compatible environment

Before opening persisted pi history, the pi backend SHALL read the most recent pi session header and compare its recorded CWD with the CWD derived from the session's execution environment. Compatibility SHALL use normalized absolute paths and filesystem canonical identity for project roots. The backend MUST NOT pass a different CWD override to `SessionManager.open()`.

When no pi history exists, the backend SHALL create a new pi session with the environment CWD. When history exists but its header is missing, malformed, unreadable, or incompatible, initialization SHALL fail loudly rather than opening it with an override or silently starting empty history. Legacy incompatibilities SHALL be handled only by canonical offline filesystem migration step 2 while the service is stopped.

#### Scenario: Compatible project history reopens

- **GIVEN** a project session identifies canonical root `/srv/project-a`
- **AND** its most recent pi history header records a path canonically equivalent to `/srv/project-a`
- **WHEN** the runner initializes
- **THEN** the backend SHALL reopen that history without a CWD override
- **AND** the complete model context SHALL remain available

#### Scenario: Compatible personal history reopens

- **GIVEN** a personal session's pi history header records `$GOBLIN_HOME/workspace`
- **WHEN** the runner initializes
- **THEN** the backend SHALL reopen that history under the personal environment

#### Scenario: No history creates environment-scoped history

- **GIVEN** the session has no pi JSONL history
- **WHEN** the runner initializes
- **THEN** the backend SHALL create a new pi session whose header CWD equals the session environment CWD

#### Scenario: Incompatible history fails loudly

- **GIVEN** a project session identifies `/srv/project-a`
- **AND** its most recent pi history header records `/srv/project-b`
- **WHEN** the runner initializes
- **THEN** initialization SHALL fail with an environment-compatibility error
- **AND** the backend SHALL NOT call `SessionManager.open()` with `/srv/project-a` as an override
- **AND** SHALL NOT create silent empty history

#### Scenario: Malformed history header fails loudly

- **GIVEN** a pi history file exists but its session header cannot be parsed or has no valid CWD
- **WHEN** the runner initializes
- **THEN** initialization SHALL fail and log the affected session history path

## MODIFIED Requirements

### Requirement: Project AGENTS is exact project guidance

For a session with a project execution environment, only the exact file `<projectRoot>/AGENTS.md` SHALL be eligible as project guidance. Goblin MUST NOT walk ancestors, load compatibility files, or load global instruction files as project guidance. Personal sessions SHALL load no project guidance.

#### Scenario: Project environment has AGENTS

- **WHEN** a project session's canonical root contains `AGENTS.md`
- **THEN** the constructed system prompt SHALL include that exact file as project-specific guidance
- **AND** the prompt SHALL positively scope it to project files, commands, tests, and conventions

#### Scenario: Project environment lacks AGENTS

- **WHEN** a project session's canonical root lacks `AGENTS.md`
- **THEN** prompt construction SHALL proceed without project guidance

#### Scenario: Personal environment ignores project guidance

- **WHEN** a personal session initializes
- **THEN** project guidance discovery SHALL NOT run

### Requirement: Project AGENTS does not replace deployment voice

Project guidance from a project execution environment SHALL supplement the deployed Goblin prompt. It MUST NOT replace `$GOBLIN_HOME/workspace/SOUL.md` or become the deployed conversational identity.

#### Scenario: Project and SOUL both exist

- **WHEN** both `$GOBLIN_HOME/workspace/SOUL.md` and `<projectRoot>/AGENTS.md` exist
- **THEN** the constructed system prompt SHALL include both sections
- **AND** section scoping SHALL define project guidance as repository/workspace instructions rather than deployment voice

## REMOVED Requirements

### Requirement: AgentRunner uses projectDir for cwd and agentDir

### Requirement: projectDir sourced from binding

### Requirement: SessionState projectDir is deprecated

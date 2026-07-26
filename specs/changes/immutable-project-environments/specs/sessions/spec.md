# sessions

## ADDED Requirements

### Requirement: Execution environments have canonical persisted identities

The sessions module SHALL represent an execution environment as exactly one of two discriminated values: `personal`, whose working directory is `$GOBLIN_HOME/scratch/workdir`, or `project`, whose `projectRoot` is an absolute canonical directory returned by filesystem realpath resolution. A project root MUST exist and be a directory before first assignment. There SHALL be no project registry or generated environment identifier; two project environments with the same canonical root are equal.

#### Scenario: Personal environment

- **WHEN** the personal execution environment is resolved
- **THEN** its working directory SHALL be `$GOBLIN_HOME/scratch/workdir`
- **AND** its persisted value SHALL NOT contain a project path

#### Scenario: Symlinked project path is canonicalized

- **GIVEN** `/srv/project-link` is a symlink to `/srv/project-a`
- **WHEN** `/srv/project-link` is resolved as a project execution environment
- **THEN** the persisted `projectRoot` SHALL be `/srv/project-a`
- **AND** resolving `/srv/project-a` SHALL produce the same environment identity

#### Scenario: Invalid project root is rejected

- **WHEN** a requested project root is missing or is not a directory
- **THEN** environment resolution SHALL fail
- **AND** no surface setting or session state SHALL change

### Requirement: Session state captures an immutable execution environment

Every newly created session state SHALL persist an `executionEnvironment` copied from the creating Surface's effective environment. It MUST NOT change for the lifetime of that session. Internal non-Telegram sessions SHALL use `personal`.

#### Scenario: Personal session

- **WHEN** a session is created for an unassigned Surface
- **THEN** `state.json` SHALL contain `executionEnvironment: { "kind": "personal" }`

#### Scenario: Project session

- **WHEN** a session is created for a Surface assigned to `/srv/project-a`
- **THEN** `state.json` SHALL contain `executionEnvironment: { "kind": "project", "projectRoot": "/srv/project-a" }`

#### Scenario: Existing history remains immutable

- **GIVEN** a Surface is bound to personal session P
- **WHEN** the Surface receives its first project assignment
- **THEN** P SHALL remain stored with its personal environment
- **AND** the new bound session SHALL persist the project environment

#### Scenario: Internal session

- **WHEN** `ensureInternal()` creates an internal session
- **THEN** it SHALL persist the personal environment

### Requirement: Surface environment resolution preserves isolation

The session manager SHALL resolve an unassigned Surface to `personal` and an assigned Surface to its canonical project environment. Multiple Surfaces MAY share one environment, but their bindings, histories, memory scopes, schedules, queues, and delivery MUST NOT merge because their environment is equal.

#### Scenario: Two Surfaces share a project root

- **GIVEN** Surface A and Surface B are assigned `/srv/project-a`
- **WHEN** their environments are resolved
- **THEN** both SHALL have the same environment identity
- **AND** each SHALL retain independent bindings and history

### Requirement: Session manager owns one-time Surface project assignment

The session manager SHALL expose one operation that assigns a canonical project environment to an unassigned Surface, creates a fresh project session, and rebinds the Surface while leaving the displaced personal session stored. The operation SHALL report an identical assignment without rotating and SHALL reject a conflicting assignment. Callers MUST NOT coordinate settings, state, bindings, and runner replacement independently.

#### Scenario: First assignment

- **GIVEN** an unassigned Surface is bound to personal session P
- **WHEN** `/srv/project-a` is assigned
- **THEN** the manager SHALL persist the assignment and create project session Q
- **AND** bind Q to the Surface
- **AND** leave P stored and resumable

#### Scenario: Identical assignment

- **GIVEN** a Surface is assigned `/srv/project-a`
- **WHEN** the assignment operation receives a path canonicalizing to `/srv/project-a`
- **THEN** it SHALL report the existing assignment
- **AND** SHALL NOT create a session or change the binding

#### Scenario: Conflicting assignment

- **GIVEN** a Surface is assigned `/srv/project-a`
- **WHEN** the operation receives `/srv/project-b` or a request for personal mode
- **THEN** it SHALL reject the request
- **AND** SHALL leave settings and binding unchanged

### Requirement: Legacy execution environments migrate before dispatch

Startup SHALL idempotently migrate every live, unbound, archived, and internal legacy session before polling or scheduled dispatch. Bound sessions SHALL receive their bound Surface's effective environment; unbound sessions SHALL use their recorded legacy Surface when it can be resolved uniquely; internal sessions SHALL receive `personal`. The migration SHALL normalize the most recent pi session header CWD to the assigned environment through atomic replacement while preserving every non-header history entry. Invalid or ambiguous authority MUST fail loudly rather than silently selecting personal or dropping history.

#### Scenario: Bound project history migrates

- **GIVEN** a Surface is assigned a legacy `projectDir` resolving to `/srv/project-a`
- **AND** it is bound to a session without `executionEnvironment`
- **WHEN** migration runs
- **THEN** the setting and session SHALL store canonical project root `/srv/project-a`
- **AND** bindings, transcript, memory scope, schedules, and non-header pi history SHALL remain unchanged

#### Scenario: Unbound legacy history migrates

- **GIVEN** an unbound session's recorded Surface resolves uniquely to `/srv/project-a`
- **WHEN** migration runs
- **THEN** the session SHALL receive that project environment
- **AND** remain unbound and resumable

#### Scenario: Legacy pi header is normalized

- **GIVEN** a migrated session is assigned `/srv/project-a`
- **AND** its legacy pi header records another CWD because mutable `/project` used an override
- **WHEN** migration runs
- **THEN** the header CWD SHALL be atomically normalized to `/srv/project-a`
- **AND** every non-header entry SHALL be preserved

#### Scenario: Invalid migration blocks startup

- **WHEN** a legacy project path or Surface association is invalid or ambiguous
- **THEN** startup SHALL fail with the affected record and reason
- **AND** polling and scheduled dispatch SHALL NOT start

#### Scenario: Migration rerun is idempotent

- **WHEN** migration reruns after a complete or interrupted attempt
- **THEN** matching canonical records SHALL remain unchanged
- **AND** no session, binding, or history branch SHALL be duplicated

## MODIFIED Requirements

### Requirement: Resolve sessions from complete Surface values

`SessionManager.resolve(surface)` SHALL accept a complete Surface with no routing options and preserve the dependency-defined creation/stale-binding policies. Every session it creates, including stale-binding replacements, SHALL capture the Surface's effective execution environment and SHALL NOT contain a legacy `projectDir`. Returning an existing bound session MUST NOT change its environment.

#### Scenario: Auto-created session captures environment

- **WHEN** an auto-creating Surface assigned to `/srv/project-a` has no live binding
- **THEN** `resolve()` SHALL create a session with the project environment for `/srv/project-a`

#### Scenario: Existing session stays immutable

- **WHEN** `resolve()` returns an existing bound session
- **THEN** it SHALL return the persisted execution environment unchanged

### Requirement: Surface-based creation and rebinding preserve conversation identity

`createForSurface(surface)` SHALL create a session with the Surface's effective execution environment. `bindExistingToSurface(sessionId, surface)` SHALL reject an environment mismatch before changing the binding; matching sessions retain their immutable environment and history.

#### Scenario: Creation captures current environment

- **WHEN** `createForSurface()` creates a session on a project Surface
- **THEN** the new state SHALL persist the Surface's canonical project environment

#### Scenario: Mismatched binding is rejected

- **GIVEN** a personal session and a project Surface
- **WHEN** `bindExistingToSurface()` is requested
- **THEN** it SHALL reject before changing the binding

### Requirement: Surface settings are keyed by SurfaceId

`state/topic-settings.json` SHALL continue to use the dependency-provided canonical SurfaceId key space. A Surface's optional project assignment SHALL be stored as canonical `projectRoot`; absence SHALL mean personal. The record MUST NOT expose a mutable clear/switch operation or retain a pending notice claiming that an existing conversation's CWD changed.

#### Scenario: Canonical assignment is stored

- **WHEN** a Surface receives its first project assignment
- **THEN** its settings SHALL contain canonical `projectRoot`
- **AND** SHALL NOT contain legacy `projectDir` or `pendingProjectNotice`

#### Scenario: Unassigned Surface is personal

- **WHEN** no `projectRoot` exists for a Surface
- **THEN** its effective environment SHALL be personal

### Requirement: Export session types and manager

The sessions module SHALL export `SessionManager`, `SessionState`, `ExecutionEnvironment`, and the Surface identity types required by callers. Session operations SHALL accept complete Surface values.

#### Scenario: Module import

- **WHEN** a caller imports from `src/sessions/mod.ts`
- **THEN** it SHALL have access to the manager and execution-environment types

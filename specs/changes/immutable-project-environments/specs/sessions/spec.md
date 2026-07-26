# sessions

## ADDED Requirements

### Requirement: Execution environments have canonical persisted identities

The sessions module SHALL represent an execution environment as exactly one of two discriminated values: `personal`, whose working directory is the persistent `$GOBLIN_HOME/workspace`, or `project`, whose `projectRoot` is an absolute canonical directory returned by filesystem realpath resolution. A project root MUST exist and be a directory before first assignment. There SHALL be no project registry or generated environment identifier; two project environments with the same canonical root are equal.

#### Scenario: Personal environment

- **WHEN** the personal execution environment is resolved
- **THEN** its working directory SHALL be `$GOBLIN_HOME/workspace`
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

The session manager SHALL expose one operation that assigns a canonical project environment to an unassigned Surface and creates and binds a fresh project session. A current personal session is optional: when present it SHALL remain stored after displacement; when absent the operation SHALL create the Surface's first project session directly. The operation SHALL report an identical assignment without rotating and SHALL reject a conflicting assignment. Callers MUST NOT coordinate settings, state, bindings, and runner replacement independently.

#### Scenario: First assignment

- **GIVEN** an unassigned Surface is bound to personal session P
- **WHEN** `/srv/project-a` is assigned
- **THEN** the manager SHALL persist the assignment and create project session Q
- **AND** bind Q to the Surface
- **AND** leave P stored and resumable

#### Scenario: First assignment while unbound

- **GIVEN** an unassigned Surface has no current binding
- **WHEN** `/srv/project-a` is assigned
- **THEN** the manager SHALL create project session Q and bind it directly
- **AND** SHALL NOT create a personal session first

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

### Requirement: Binding-changing lifecycle operations serialize globally

Project assignment SHALL execute under the same process-wide lifecycle-transition lock used by Conversation binding operations. The lock MUST cover validation re-read through durable commit/recovery fencing, including unbound-Surface creation; per-runtime queues SHALL NOT be treated as sufficient serialization.

#### Scenario: Unbound creation races with project assignment

- **GIVEN** an unbound Surface receives `/project` and ordinary content concurrently
- **WHEN** both operations attempt to create and bind a Conversation
- **THEN** one complete lifecycle transition SHALL finish before the other re-reads state
- **AND** no duplicate binding, wrong-environment Conversation, or orphaned untracked history SHALL result

#### Scenario: Resume and project assignment overlap

- **WHEN** cross-Surface `/resume` overlaps first project assignment
- **THEN** the shared transition lock SHALL serialize their binding/environment authority checks and commits

### Requirement: Project assignment intent precedes Conversation creation

For a bound Surface, first assignment SHALL synchronously invalidate and quiesce the prior runtime before durable assignment work; failure SHALL leave no pending intent or future Conversation while preserving settings/binding and never restoring the invalidated runtime object. After successful quiescence, or immediately for an unbound Surface, assignment SHALL allocate the future project Conversation ID and atomically persist a pending intent containing the SurfaceId, optional prior Conversation ID, future Conversation ID, and canonical project root before creating the future Conversation directory or writing assignment settings/bindings. Creation and startup replay SHALL use that recorded ID idempotently. While the intent exists, runtime construction and competing binding/environment mutations for its Surface MUST be fenced behind replay. A post-intent crash or write failure MUST NOT leave an untracked Conversation or cause retry to create another one.

#### Scenario: Prior runtime quiescence fails before durable assignment

- **GIVEN** an unassigned Surface is bound to personal Conversation P
- **WHEN** required runtime quiescence fails
- **THEN** no pending intent or future project Conversation SHALL exist
- **AND** assignment and binding SHALL remain unchanged
- **AND** the invalidated runtime object SHALL NOT be restored or reused

#### Scenario: Crash after intent persistence

- **WHEN** startup finds a valid pending assignment whose future Conversation does not yet exist
- **THEN** replay SHALL create it at the recorded ID with the recorded immutable environment
- **AND** SHALL complete the assignment without allocating another ID

#### Scenario: Crash after Conversation creation

- **WHEN** startup finds both a pending assignment and its matching future Conversation
- **THEN** replay SHALL verify the Conversation against the intent and reuse it
- **AND** SHALL NOT create a duplicate Conversation

#### Scenario: Crash after settings before binding

- **GIVEN** replay finds the recorded project assignment persisted while the binding is absent or still points to recorded P
- **WHEN** the future Conversation Q matches the pending intent
- **THEN** replay SHALL atomically bind Q without allocating another Conversation

#### Scenario: Crash after binding before intent cleanup

- **GIVEN** project assignment and binding Q already match the pending intent
- **WHEN** replay runs
- **THEN** it SHALL clear only the completed pending intent
- **AND** SHALL NOT recreate Q or repeat runtime cleanup

#### Scenario: Pending assignment fences the Surface

- **GIVEN** a pending assignment exists after an interrupted or failed in-process transition
- **WHEN** another operation attempts to construct a runtime or mutate binding/environment state for that Surface
- **THEN** it SHALL reconcile or report the pending operation first
- **AND** SHALL NOT reopen the old runtime or start a competing transition

#### Scenario: Existing future ID conflicts with intent

- **WHEN** the recorded future Conversation ID already exists with different state or environment
- **THEN** startup SHALL fail before changing settings or bindings
- **AND** SHALL report the pending intent and conflicting path

### Requirement: Legacy execution environments migrate before dispatch

Startup SHALL idempotently migrate every live, unbound, archived, and internal legacy session before polling or scheduled dispatch. Migration SHALL group bindings by session: a bound session may receive the common effective environment of one or several bound Surfaces only when every candidate is equal; differing candidates MUST fail before writes without choosing by map or lexical order. Unbound sessions SHALL use their recorded legacy Surface when it can be resolved uniquely; internal sessions SHALL receive `personal`. Migration SHALL validate every retained pi-history JSONL header for the session, not only the newest file. It MAY atomically normalize a header only for the explicit personal-workspace relocation or a canonically equivalent path spelling, while preserving every non-header history entry. A header identifying a different Execution Environment, or any other invalid or ambiguous authority, MUST fail before state/history writes for explicit operator repair rather than being relabeled, silently assigned personal, or dropped.

#### Scenario: Bound project history migrates

- **GIVEN** a Surface is assigned a legacy `projectDir` resolving to `/srv/project-a`
- **AND** it is bound to a session without `executionEnvironment`
- **WHEN** migration runs
- **THEN** the setting and session SHALL store canonical project root `/srv/project-a`
- **AND** bindings, transcript, memory scope, schedules, and non-header pi history SHALL remain unchanged

#### Scenario: Multi-bound legacy history has one common environment

- **GIVEN** a legacy session is bound to several Surfaces whose effective environments are equal
- **WHEN** environment migration runs
- **THEN** the session MAY capture that common environment
- **AND** this migration SHALL leave binding selection to the later explicit multi-binding repair

#### Scenario: Multi-bound legacy history has conflicting environments

- **GIVEN** a legacy session is bound to Surfaces with different effective environments
- **WHEN** environment migration runs
- **THEN** startup SHALL fail before state or history writes
- **AND** the diagnostic SHALL identify the session and every candidate Surface/environment

#### Scenario: Unbound legacy history migrates

- **GIVEN** an unbound session's recorded Surface resolves uniquely to `/srv/project-a`
- **WHEN** migration runs
- **THEN** the session SHALL receive that project environment
- **AND** remain unbound and resumable

#### Scenario: Mixed-environment legacy pi history is refused

- **GIVEN** a migrated session's selected environment is project `/srv/project-a`
- **AND** its legacy pi header resolves to another Execution Environment because mutable `/project` crossed authority boundaries
- **WHEN** migration runs
- **THEN** startup SHALL fail before changing the session state or pi history
- **AND** the diagnostic SHALL identify the session, selected environment, history path, and recorded CWD
- **AND** the header and every non-header entry SHALL remain unchanged

#### Scenario: Canonically equivalent project header is normalized

- **GIVEN** a migrated session is assigned `/srv/project-a`
- **AND** its pi header uses a path spelling whose realpath is `/srv/project-a`
- **WHEN** migration runs
- **THEN** the header MAY be atomically normalized to `/srv/project-a`
- **AND** every non-header entry SHALL be preserved byte-for-byte

#### Scenario: Legacy personal workdir is promoted to workspace

- **GIVEN** a personal session whose legacy pi header records `$GOBLIN_HOME/scratch/workdir`
- **WHEN** migration runs
- **THEN** the header CWD SHALL be atomically normalized to `$GOBLIN_HOME/workspace`
- **AND** existing regular files from the legacy personal workdir SHALL be moved into the workspace without replacing an existing workspace path
- **AND** a path collision SHALL fail loudly with both paths rather than discard either file

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

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

The canonical offline migration runner SHALL register execution-environment conversion as filesystem step 2, mapping `stateVersion` 1 to 2 after Surface migration step 1. It SHALL run only through explicit `bun run migrate` while Goblin is stopped. In a multi-step run, step 2 SHALL plan against step 1's projected canonical outputs, and every later pending plan SHALL validate before any step is applied. Startup SHALL only reject a version mismatch and name the migration remedy. Pending project-assignment replay SHALL remain separate startup reconciliation over current-version state.

The migration command SHALL be the sole recovery-backup owner. Before source mutation or setup creation, its restorable backup SHALL cover `state/`, `workspace/`, and legacy `scratch/workdir/`, including prior path existence. `scripts/update.sh` SHALL stop Goblin before invoking this boundary, perform no narrower duplicate backup, restart only after success, and leave Goblin stopped on failure. The step SHALL compute and validate its complete settings, workdir-promotion, Conversation-state, and pi-header plan before its first write or rename. It SHALL reject every workdir collision, invalid assigned project root, conflicting or ambiguous Surface authority, malformed history, and incompatible history before mutation rather than deleting settings, selecting a winner, relabeling history, silently assigning personal, or dropping data.

The plan SHALL include every live, unbound, archived, and internal legacy Conversation and SHALL use this authority matrix:

- A Surface setting containing both `projectRoot` and legacy `projectDir` is valid only when both canonicalize to the same project root.
- An internal legacy Conversation (`chatId === 0`) SHALL select `personal`, MUST NOT be Surface-bound, and MUST NOT carry project evidence.
- A bound Conversation SHALL gather every bound Surface's effective environment; all candidates and any legacy Conversation `projectDir` MUST agree.
- An unbound or archived Conversation SHALL gather its legacy state `projectDir` and every Surface setting matching its recorded legacy chat/topic address. Conflicting candidates SHALL fail; no project evidence SHALL select `personal`; malformed or missing routing identity SHALL fail rather than default.
- A Conversation already carrying canonical `executionEnvironment` SHALL retain it only when every applicable legacy and binding candidate agrees; migration MUST NOT overwrite a canonical disagreement.

Every retained pi-history JSONL header SHALL be validated against the selected environment, not only the newest file. The step MAY normalize a header only for the explicit personal-workspace relocation or a canonically equivalent project path, preserving every non-header entry byte-for-byte.

The migration runner SHALL write version 2 only after the complete step succeeds. On failure it SHALL leave version 1 and require restoration from its backup before retry. The step SHALL use no independent migration marker and SHALL NOT be required to be idempotent, restart-safe, mixed-generation tolerant, or rerunnable after partial writes.

#### Scenario: Bound project history migrates

- **GIVEN** a Surface is assigned a legacy `projectDir` resolving to `/srv/project-a`
- **AND** it is bound to a session without `executionEnvironment`
- **WHEN** migration runs
- **THEN** the setting and session SHALL store canonical project root `/srv/project-a`
- **AND** bindings, transcript, memory scope, schedules, and non-header pi history SHALL remain unchanged

#### Scenario: Canonical and legacy setting fields disagree

- **GIVEN** one Surface setting contains canonical `projectRoot` `/srv/project-a` and legacy `projectDir` resolving to `/srv/project-b`
- **WHEN** step 2 is planned
- **THEN** migration SHALL fail before mutation with the Surface and both roots
- **AND** SHALL NOT prefer the canonical field merely because it is newer

#### Scenario: Existing canonical Conversation disagrees with its binding

- **GIVEN** a Conversation already records project environment `/srv/project-a`
- **AND** its bound Surface resolves to project environment `/srv/project-b`
- **WHEN** step 2 is planned
- **THEN** migration SHALL fail before mutation
- **AND** SHALL NOT overwrite either authority source

#### Scenario: Recorded and bound legacy authority disagree

- **GIVEN** a bound legacy Conversation carries `projectDir` `/srv/project-a`
- **AND** its bound Surface resolves to project environment `/srv/project-b`
- **WHEN** step 2 is planned
- **THEN** migration SHALL fail before mutation and identify both candidates

#### Scenario: Multi-bound legacy history has one common environment

- **GIVEN** a legacy session is bound to several Surfaces whose effective environments are equal
- **WHEN** environment migration runs
- **THEN** the session MAY capture that common environment
- **AND** this migration SHALL leave binding selection to the later explicit multi-binding repair

#### Scenario: Multi-bound legacy history has conflicting environments

- **GIVEN** a legacy session is bound to Surfaces with different effective environments
- **WHEN** environment migration runs
- **THEN** the offline migration command SHALL fail before any step-2 mutation
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
- **THEN** the offline migration command SHALL fail before any step-2 mutation
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

#### Scenario: Invalid migration leaves the old version

- **GIVEN** persisted state is at version 1
- **WHEN** a legacy project path, workdir destination, Surface association, or retained history is invalid or ambiguous
- **THEN** the offline migration command SHALL fail with the affected record and reason before any step-2 mutation
- **AND** `stateVersion` SHALL remain 1
- **AND** a later startup SHALL refuse to poll and name `bun run migrate`

#### Scenario: Migration backup covers workdir promotion

- **GIVEN** step 2 will move an entry from `scratch/workdir` into `workspace`
- **WHEN** the migration command takes its pre-mutation backup
- **THEN** that backup SHALL preserve the prior contents and existence of `state/`, `workspace/`, and `scratch/workdir/`
- **AND** restoring it SHALL remove any destination that did not exist before the attempt

#### Scenario: Successful step advances exactly once

- **GIVEN** persisted state is at version 1 and the complete plan is valid
- **WHEN** step 2 succeeds
- **THEN** the runner SHALL write `stateVersion` 2 only after every planned mutation completes
- **AND** a later migration invocation at version 2 SHALL not invoke step 2 again

#### Scenario: Startup does not migrate legacy environments

- **GIVEN** persisted state remains at version 1
- **WHEN** Goblin starts normally
- **THEN** it SHALL refuse to begin polling with the required version and migration remedy
- **AND** SHALL NOT move workdir entries, rewrite settings, Conversation state, or pi history

#### Scenario: Startup does not recreate the legacy personal workdir

- **GIVEN** migration has promoted legacy `scratch/workdir` contents into `workspace` and advanced `stateVersion` to 2
- **WHEN** Goblin starts normally
- **THEN** startup directory creation SHALL NOT recreate `scratch/workdir`
- **AND** the personal environment working directory SHALL remain `$GOBLIN_HOME/workspace`
- **AND** personal delegated subagent fallback and preflight SHALL use `$GOBLIN_HOME/workspace`

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

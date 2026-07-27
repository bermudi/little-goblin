# Capability: Project Directory Command

## Requirements

### Requirement: path parsing and resolution

The command SHALL parse the argument using space-safe extraction of everything after `/project`, expand `~`, resolve relative paths against the Goblin process CWD, and then use filesystem realpath resolution before validation, comparison, display, or persistence. The resulting project root MUST be absolute and canonical.

#### Scenario: Tilde expansion for home directory

- **WHEN** the user sends `/project ~`
- **THEN** the path SHALL be expanded to the user's home directory
- **AND** its filesystem canonical path SHALL be used

#### Scenario: Tilde expansion for home subdirectory

- **WHEN** the user sends `/project ~/foo`
- **THEN** the path SHALL be expanded to `$HOME/foo`
- **AND** its filesystem canonical path SHALL be used

#### Scenario: Relative path resolution

- **WHEN** the user sends `/project ./src`
- **THEN** the path SHALL first resolve relative to the Goblin process CWD
- **AND** the persisted root SHALL be its filesystem canonical path

#### Scenario: Paths with spaces

- **WHEN** the user sends `/project /home/daniel/my projects/foo`
- **THEN** the full path including spaces SHALL be captured and canonicalized

#### Scenario: Symlink and real path compare equal

- **GIVEN** `/srv/project-link` resolves to `/srv/project-a`
- **WHEN** either spelling is parsed
- **THEN** both SHALL produce canonical project root `/srv/project-a`

### Requirement: cascade-cancel safety

`/project` SHALL use queue timing. If a turn is active, first assignment SHALL defer until it settles rather than invoking the interrupt cascade. A displaced personal runtime SHALL then be disposed before the assignment commits; an unbound Surface has no runtime-disposal prerequisite. Repeated or rejected assignments MUST NOT cancel the current turn or delegated work.

#### Scenario: First assignment during a turn

- **WHEN** `/project /srv/project-a` is sent while the personal runtime is streaming
- **THEN** the command SHALL queue behind the turn
- **AND** SHALL NOT call `interruptAndCascade`
- **AND** SHALL dispose the personal runtime before committing the project binding

#### Scenario: Rejected assignment does not cancel

- **WHEN** `/project` requests a different root on an assigned Surface
- **THEN** no running turn or delegated work SHALL be cancelled

### Requirement: runner disposal on change

On a Surface's first project assignment, an existing personal Conversation's `AgentRunner` SHALL be disposed and removed from the active runner map, and a runner for the fresh project Conversation SHALL be registered lazily without reusing personal model context. If the Surface is unbound, no runner SHALL be synthesized or disposed. Repeated or rejected assignments SHALL NOT dispose the current project runner.

#### Scenario: Runner replacement during first assignment

- **WHEN** `/project <path>` first assigns the current Surface
- **THEN** the personal session's existing runner SHALL be disposed
- **AND** it SHALL be removed from the runner map even if `dispose()` throws
- **AND** the fresh project session SHALL use its own runner and pi history

#### Scenario: Unbound assignment has no displaced runner

- **GIVEN** an unassigned Surface has no bound Conversation
- **WHEN** `/project <path>` creates and binds its first project Conversation
- **THEN** the operation SHALL NOT create or dispose a personal runner
- **AND** the project runner SHALL remain lazy until first dispatch

#### Scenario: Disposal failure precedes durable assignment

- **GIVEN** the Surface is bound to personal Conversation P
- **WHEN** first assignment cannot quiesce P's runtime
- **THEN** the assignment SHALL fail
- **AND** no pending intent or project Conversation Q SHALL exist
- **AND** assignment and binding SHALL remain unchanged
- **AND** P's invalidated runtime object SHALL NOT be reused

#### Scenario: Same assignment leaves runner intact

- **WHEN** `/project <path>` resolves to the Surface's existing canonical project root
- **THEN** the current runner SHALL NOT be disposed or replaced

#### Scenario: Rejected assignment leaves runner intact

- **WHEN** `/project <path>` requests a different canonical root or `/project none` requests personal mode
- **THEN** the current runner SHALL NOT be disposed or replaced

### Requirement: /project binding persists across restarts

A Surface's canonical project assignment SHALL persist in `topic-settings.json`, survive process restarts, and apply to every future session created on that Surface. `/new` SHALL create a fresh session with the same immutable project execution environment; it MUST NOT copy a mutable `projectDir` field or change the Surface assignment.

#### Scenario: Assignment survives restart

- **WHEN** a Surface has canonical project root `/srv/project-a` in `topic-settings.json`
- **AND** Goblin restarts
- **THEN** the Surface's effective environment SHALL still be the project environment for `/srv/project-a`
- **AND** the bound session's persisted environment SHALL remain unchanged

#### Scenario: Assignment survives /new

- **WHEN** a Surface assigned to `/srv/project-a` receives `/new`
- **THEN** the new session SHALL persist the project execution environment for `/srv/project-a`
- **AND** its `state.json` SHALL NOT contain a legacy `projectDir` field
- **AND** the Surface assignment SHALL remain `/srv/project-a`

### Requirement: /project assigns a Surface once and starts fresh history

The `/project <path>` command SHALL convert an unassigned Surface from its effective personal environment to one immutable project assignment whether or not a Conversation is currently bound. On first assignment it SHALL canonicalize and persist the project root, create a fresh project Conversation, and bind it to the same Surface. If a personal Conversation is currently bound, the operation SHALL leave it stored and resumable and dispose its active runner; if the Surface is unbound, it SHALL create the first project Conversation directly. It MUST NOT create a disposable personal Conversation or reopen personal pi history under the project CWD.

If the Surface is already assigned, the command SHALL compare canonical roots. The same root SHALL be reported without creating another session or disposing a runner. A different root, `/project none`, and `/project clear` SHALL be rejected without changing state, with guidance to use another Telegram topic or Surface for a different environment. Separate Surfaces MAY assign the same canonical project root.

#### Scenario: First project assignment

- **GIVEN** the current Surface has no project assignment and is bound to personal session P
- **WHEN** the user sends `/project /srv/project-a`
- **THEN** the Surface SHALL be assigned canonical project root `/srv/project-a`
- **AND** a fresh project session Q SHALL be created and bound to the Surface
- **AND** P SHALL remain stored and resumable with its personal environment and history unchanged
- **AND** P's active runner SHALL be disposed
- **AND** the reply SHALL identify `/srv/project-a` as the assigned project

#### Scenario: Same canonical project repeated

- **GIVEN** the Surface is assigned `/srv/project-a` and bound to project session Q
- **AND** `/srv/project-link` resolves canonically to `/srv/project-a`
- **WHEN** the user sends `/project /srv/project-link`
- **THEN** the command SHALL report that the Surface is already assigned to `/srv/project-a`
- **AND** SHALL NOT create a session, change the binding, or dispose Q's runner

#### Scenario: Same assignment on an assigned but unbound Surface

- **GIVEN** the Surface is assigned `/srv/project-a` but has no current binding
- **WHEN** `/project` receives a path canonicalizing to `/srv/project-a`
- **THEN** it SHALL report the existing assignment
- **AND** SHALL NOT create or bind another Conversation

#### Scenario: Different project is rejected

- **GIVEN** the Surface is assigned `/srv/project-a`
- **WHEN** the user sends `/project /srv/project-b`
- **THEN** the command SHALL reject the change
- **AND** the reply SHALL direct the user to create or use another Telegram topic or Surface
- **AND** the existing assignment, binding, session, and runner SHALL remain unchanged

#### Scenario: Clearing an assignment is rejected

- **GIVEN** the Surface is assigned `/srv/project-a`
- **WHEN** the user sends `/project none` or `/project clear`
- **THEN** the command SHALL reject returning the Surface to the personal environment
- **AND** the existing assignment, binding, session, and runner SHALL remain unchanged

#### Scenario: Separate Surfaces share a project

- **GIVEN** Surface A is already assigned `/srv/project-a`
- **WHEN** the user first assigns Surface B to a path canonicalizing to `/srv/project-a`
- **THEN** Surface B SHALL receive its own fresh project session and binding
- **AND** Surface A's binding and session SHALL remain unchanged

#### Scenario: First project assignment on an unbound Surface

- **GIVEN** the Surface has no project assignment and no bound Conversation
- **WHEN** the user sends `/project /srv/project-a`
- **THEN** the Surface SHALL be assigned canonical project root `/srv/project-a`
- **AND** a fresh project Conversation SHALL be created and bound directly
- **AND** no provisional personal Conversation SHALL be created

#### Scenario: Missing argument

- **WHEN** the user sends `/project` without a path argument
- **THEN** the command SHALL return usage guidance for `/project <path>`
- **AND** SHALL NOT change the Surface assignment or binding

#### Scenario: Path does not exist or is not a directory

- **WHEN** the user sends `/project` with a missing path or a file path
- **THEN** the command SHALL reply that the path is not an accessible directory
- **AND** SHALL NOT change the Surface assignment or binding

#### Scenario: Path is not accessible

- **WHEN** the user sends `/project` with a directory the Goblin process cannot read, write, or search
- **THEN** the command SHALL reject the path
- **AND** SHALL NOT change the Surface assignment or binding

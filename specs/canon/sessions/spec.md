# sessions

## Requirements

### Requirement: Persist bindings atomically

The system SHALL persist one canonical `SurfaceId -> conversationId` binding map using atomic replacement. Binding mutation helpers SHALL preserve the one-active-binding-per-conversation invariant and SHALL never infer surface kind from numeric identifiers.

#### Scenario: Binding move is saved

- **WHEN** a conversation moves between surfaces
- **THEN** removal of the old binding, displacement at the destination, and creation of the new binding SHALL be represented by one atomic write

### Requirement: Write transcript entries on message completion

The system SHALL append final message entries to `transcript.jsonl` when pi emits `message_end` events. All reads and writes SHALL continue to cross the single transcript module, which owns `TranscriptEntry`, normalization, parsing, range reads, display-text extraction, and chunking.

`TranscriptEntry` SHALL add optional `sourceSurfaceId: SurfaceId`. Every new entry produced by a user-visible main conversation runtime—including user, assistant, tool-result, and synthetic assistant entries—MUST carry the canonical SurfaceId captured by that runtime. The writer SHALL require explicit context discriminated as Surface-backed or internal; a Surface-backed write cannot omit provenance, while an internal write SHALL omit it. `AgentRunner` SHALL freeze that context from its completed runtime capture, and event/synthetic callers SHALL pass the runner or its context rather than a Conversation ID or binding reader. If a synthetic user-visible reply has no current writer context, the caller SHALL deliver it without appending JSONL and emit a bounded `no-transcript-writer-context` signal. Callers MUST NOT construct transcript values directly, create a runtime merely to stamp a reply, query a current binding during event handling, or rewrite old entries when a Conversation moves.

The reader SHALL expose normalized typed entries to ordinary consumers and a named migration-only lossless-record operation only to `TranscriptProvenanceMigrator`. Ordinary readers, indexers, dreaming, commands, and intake MUST NOT import or receive raw records; a static boundary test SHALL enforce that restriction. A normalized entry SHALL expose `sourceSurfaceId` only when its raw field is a canonical SurfaceId; absent, non-string, malformed, unknown-version, and non-canonical raw values SHALL leave typed provenance unavailable while preserving readable entry text and fields. An unchanged raw record SHALL be re-emitted byte-for-byte. Any rewrite SHALL preserve every raw field, including an invalid `sourceSurfaceId`; migration MAY add proven provenance only where the field is absent and SHALL NOT replace invalid input with a guess. The range reader's `TranscriptLine` and the chunker's output SHALL preserve validated provenance for indexing and dreaming. Existing max-500-character chunking, timestamp/role/Conversation-ID provenance, noise skipping, and round-trip guarantees SHALL remain unchanged.

#### Scenario: Runtime message carries event-time Surface

- **WHEN** a Surface-backed runtime receives `message_end`
- **THEN** the transcript module SHALL append the normalized entry with the runtime capture's `sourceSurfaceId`
- **AND** SHALL not inspect the Conversation's current binding

#### Scenario: Conversation moves between entries

- **GIVEN** earlier entries were written by a runtime on Surface X
- **WHEN** the Conversation moves and a replacement runtime on Y writes later entries
- **THEN** earlier entries SHALL retain X
- **AND** later entries SHALL carry Y

#### Scenario: Synthetic user-visible reply is attributed

- **WHEN** intake or a command appends a synthetic assistant reply for a bound user-visible runtime
- **THEN** it SHALL supply that runtime's captured SurfaceId

#### Scenario: Synthetic reply has no runtime context

- **WHEN** a user-visible synthetic reply is delivered without a current runtime writer context
- **THEN** it SHALL not append a transcript entry
- **AND** it SHALL not consult a binding or create a runtime to obtain provenance
- **AND** it SHALL emit a bounded `no-transcript-writer-context` signal

#### Scenario: Internal entry has no Surface

- **WHEN** an explicitly internal writer appends an internal model entry
- **THEN** `sourceSurfaceId` SHALL be absent
- **AND** no zero-chat or internal SurfaceId SHALL be manufactured

#### Scenario: Reader and chunker preserve provenance

- **WHEN** a valid entry with `sourceSurfaceId` is read and chunked
- **THEN** every resulting chunk SHALL expose the same validated SurfaceId
- **AND** all previously accepted transcript fields SHALL round-trip unchanged

#### Scenario: Legacy entry remains readable

- **WHEN** a transcript line has no `sourceSurfaceId` or carries an invalid legacy value
- **THEN** its text and other valid fields SHALL remain readable
- **AND** its normalized typed provenance SHALL be unavailable for indexing and dreaming
- **AND** migration/rewrite code SHALL preserve the original invalid raw field rather than replacing it with a guess

### Requirement: Topic settings file

The dependency-provided surface-settings store SHALL remain the atomic persistence module for per-surface execution assignment and pending notices, and SHALL additionally hold model and thinking preferences keyed by canonical `SurfaceId`. Missing or malformed JSON SHALL use the established default-and-warning policy; non-`ENOENT`, non-syntax errors MUST propagate.

#### Scenario: Surface settings load

- **WHEN** settings are read for a surface
- **THEN** project assignment, model preference, thinking preference, and pending notices SHALL resolve from the same canonical `SurfaceId` slot

### Requirement: Topic settings atomic write

`state/topic-settings.json` SHALL be written using atomic write (tmp file + rename).

#### Scenario: Save topic settings

- **WHEN** `saveTopicSettings()` is called
- **THEN** it SHALL write to a temp file with a random suffix in `state/`
- **AND** rename it to `state/topic-settings.json` atomically

### Requirement: Persist scheduled turn definitions

The system SHALL persist scheduled turn definitions outside conversation directories using atomic writes. Each record SHALL be owned by a canonical surface and contain its id, surface identity, kind, state, next run timestamp, recurrence and provenance metadata, plus prompt text where applicable; it MUST NOT capture a conversation ID as its durable owner. Heartbeat records SHALL store no prompt body because the surface-specific/global fallback is resolved at dispatch time.

#### Scenario: Schedule is created

- **WHEN** a user or agent creates a schedule from a bound surface
- **THEN** the record SHALL contain that `SurfaceId`
- **AND** SHALL NOT contain the current conversation ID as its owner

### Requirement: JSON state files load and save through one module

The system SHALL provide a JSON state-file module that is the exclusive interface for reading and writing the session JSON state files (`state.json`, `bindings.json`, `topic-settings.json`). The module SHALL expose a load function that takes a file path and a caller-supplied default, and a save function that takes a file path and a value. Memory store files (`memory.md`, `user.md`) are Markdown and are NOT consumers of this module.

The load function SHALL implement the read recipe: `readFileSync` → `JSON.parse`; on `ENOENT` SHALL return the caller-supplied default; on `SyntaxError` SHALL log a warning and return the caller-supplied default; all other errors SHALL propagate (fail loud). The save function SHALL serialize the value as pretty-printed JSON with a trailing newline and write it via the existing `atomicWrite` primitive (tmp + rename). The module SHALL NOT own atomic-write itself — it wraps `src/fs.ts`'s `atomicWrite`.

Each caller SHALL supply its own default value and its own result type; the module is generic over `T`. The module SHALL NOT hardcode defaults for any specific state file.

#### Scenario: Load returns parsed JSON when the file exists

- **WHEN** `loadJsonFile<BindingsFile>(path, DEFAULT_BINDINGS)` is called and `path` contains valid JSON
- **THEN** it SHALL return the parsed value typed as `BindingsFile`
- **AND** SHALL NOT invoke the default

#### Scenario: Load returns default on ENOENT

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and the file does not exist
- **THEN** it SHALL return the caller-supplied default
- **AND** SHALL NOT throw

#### Scenario: Load returns default on malformed JSON and logs

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and the file contains invalid JSON
- **THEN** it SHALL log a warning including the path and error
- **AND** SHALL return the caller-supplied default
- **AND** SHALL NOT throw

#### Scenario: Load propagates non-ENOENT, non-Syntax errors

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and `readFileSync` throws a permission error
- **THEN** the error SHALL propagate to the caller
- **AND** the default SHALL NOT be returned

#### Scenario: Save writes atomically

- **WHEN** `saveJsonFile(path, value)` is called
- **THEN** it SHALL serialize `value` as `JSON.stringify(value, null, 2) + "\n"`
- **AND** SHALL write it via `atomicWrite` (tmp file + rename)
- **AND** SHALL NOT bypass atomicity

### Requirement: Transcript module owns the transcript seam

The transcript module SHALL remain the exclusive typed interface to `transcript.jsonl`. It SHALL export the provenance-aware `TranscriptEntry`, Surface-backed and internal writer operations, reader, display-text extraction, range reader, and chunker. The writer context SHALL make omission of provenance impossible for new user-visible writes and explicit for internal writes. No consumer SHALL parse JSONL, append lines, construct transcript entries, or resolve Surface provenance independently.

#### Scenario: Surface-backed writer is explicit

- **WHEN** a main runtime or synthetic-reply caller writes an entry
- **THEN** it SHALL call the transcript module with a validated captured SurfaceId
- **AND** the module SHALL be the only code that places `sourceSurfaceId` on disk

#### Scenario: Reader is the sole provenance parser

- **WHEN** indexing or dreaming consumes transcript provenance
- **THEN** it SHALL use the transcript module's validated entry/line/chunk output
- **AND** SHALL not parse SurfaceId fields from raw JSON elsewhere

#### Scenario: Lossless records stay in migration

- **WHEN** transcript provenance migration needs a raw record for a potential rewrite
- **THEN** only `TranscriptProvenanceMigrator` SHALL obtain it through the transcript module's migration-only operation
- **AND** ordinary readers, indexers, dreaming, commands, and intake SHALL receive only normalized typed entries

#### Scenario: Range reads retain line alignment

- **WHEN** a range read encounters valid, malformed, legacy, and provenance-bearing lines
- **THEN** it SHALL preserve the accepted logical-line cursor behavior
- **AND** valid provenance SHALL remain associated with its original line

### Requirement: Startup preflight verifies filesystem persistence

The system SHALL run a persistence check before starting long polling that proves the `GOBLIN_HOME` state directory is writable and that atomic write + rename works as expected.

#### Scenario: Atomic write test succeeds

- **WHEN** the preflight persistence check runs
- **THEN** it SHALL write a temporary file under `state/`, rename it to a target name, read it back, verify contents match, and delete it

#### Scenario: State directory is not writable

- **WHEN** the preflight persistence check cannot write to `state/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

#### Scenario: Atomic rename fails

- **WHEN** the preflight persistence check writes successfully but cannot rename the temp file
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

### Requirement: Startup preflight verifies workspace and scratch writability

The system SHALL verify that the `workspace/` and `scratch/` directories are writable before starting the bot, because prompt files, memory writes, and subagent work depend on them.

#### Scenario: Workspace is read-only

- **WHEN** the preflight check cannot write to `workspace/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

#### Scenario: Scratch is read-only

- **WHEN** the preflight check cannot write to `scratch/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

### Requirement: Internal session creation for dreaming

The `SessionManager` SHALL support creating internal sessions that have no Telegram binding, via a new `ensureInternal(id: string): SessionState` method. Internal sessions are used by the dreaming pipeline (session id `__goblin_dreaming__`) and are not user-facing.

`ensureInternal(id)` SHALL be idempotent: if `sessions/<id>/state.json` already exists, it SHALL load and return the existing state. Otherwise, it SHALL create the session directory + files (transcript.jsonl, events.jsonl, metrics.jsonl), write `state.json` with `{ id, createdAt: <now>, chatId: 0 }`, and return the new state. No binding entry SHALL be written to `bindings.json`.

`chatId: 0` is a sentinel value. Telegram chat IDs are never 0 (user IDs are positive, group/channel IDs are negative). The sentinel is safe and distinguishes internal sessions from Telegram-bound sessions.

Internal sessions SHALL be excluded from `SessionManager.list()`. The `list()` method scans `sessions/` and already skips `archive/`; it SHALL also skip any session whose `state.chatId === 0`.

Internal sessions SHALL NOT be archived. `archive()` SHALL NOT be called on an internal session. The session persists for the lifetime of the goblin process.

The `SchedulerSessionSource` seam SHALL gain `ensureInternal(id: string): SessionState` so the scheduler (and dreaming pipeline) can obtain the dreaming session without depending on the full `SessionManager`.

#### Scenario: ensureInternal creates session on first call

- **GIVEN** no session directory exists for id `__goblin_dreaming__`
- **WHEN** `ensureInternal("__goblin_dreaming__")` is called
- **THEN** a session directory SHALL be created at `sessions/__goblin_dreaming__/`
- **AND** `state.json` SHALL be written with `{ id: "__goblin_dreaming__", createdAt: <ISO timestamp>, chatId: 0 }`
- **AND** no binding entry SHALL be written to `bindings.json`
- **AND** the `SessionState` SHALL be returned

#### Scenario: ensureInternal is idempotent

- **GIVEN** a session already exists for id `__goblin_dreaming__` with `chatId: 0`
- **WHEN** `ensureInternal("__goblin_dreaming__")` is called again
- **THEN** the existing `state.json` SHALL be loaded and returned
- **AND** no new directory or files SHALL be created
- **AND** no binding entry SHALL be written

#### Scenario: Internal session excluded from list

- **GIVEN** sessions `abc123` (chatId: 100), `def456` (chatId: -200), and `__goblin_dreaming__` (chatId: 0) exist
- **WHEN** `SessionManager.list()` is called
- **THEN** the result SHALL include `abc123` and `def456`
- **AND** SHALL NOT include `__goblin_dreaming__`

#### Scenario: Internal session is never archived

- **GIVEN** the dreaming session `__goblin_dreaming__` exists with `chatId: 0`
- **WHEN** `archive("__goblin_dreaming__")` is called
- **THEN** the call SHALL be rejected (throw or no-op)
- **AND** the session directory `sessions/__goblin_dreaming__/` SHALL remain in place
- **AND** `state.json` SHALL remain unchanged

### Requirement: metrics.jsonl is archived with the session

When a session is archived, the `metrics.jsonl` file SHALL be moved together with the rest of the session directory to `state/sessions/archive/<id>/metrics.jsonl`.

#### Scenario: Archive session

- **WHEN** a session is archived
- **THEN** `state/sessions/<id>/metrics.jsonl` SHALL be moved to `state/sessions/archive/<id>/metrics.jsonl`
- **AND** the original path SHALL NOT exist

### Requirement: Persist one binding map keyed by SurfaceId

The session manager SHALL persist active Telegram bindings in `state/bindings.json` as one `surfaces` map from canonical `SurfaceId` to session ID. It SHALL use the complete `Surface` supplied by the caller to derive the key. DM, topicless supergroup, guest, and each topic container SHALL remain distinct even when their numeric identifiers match. Binding lookup, creation, rebinding, clearing, and archive cleanup SHALL operate on this one map and SHALL NOT branch on chat-ID sign or separate routing flags.

#### Scenario: Binding is stored under canonical identity

- **WHEN** a session is bound to a valid surface
- **THEN** `bindings.json` SHALL contain the session ID under `surfaceId(surface)`
- **AND** it SHALL NOT add an entry to legacy `dm`, `topics`, `supergroups`, or `guest` maps

#### Scenario: Numeric collision does not collide semantically

- **WHEN** a DM, guest, and topicless supergroup have the same numeric chat ID
- **THEN** all three bindings SHALL coexist under different keys

#### Scenario: Topic containers do not collide

- **WHEN** private, forum-supergroup, and direct-messages topic surfaces have equal numeric chat and topic IDs
- **THEN** their bindings SHALL coexist under different keys

#### Scenario: Archive clears every surface binding

- **WHEN** a session bound to one or more surfaces is archived
- **THEN** every `surfaces` entry referencing that session SHALL be removed
- **AND** unrelated surface bindings SHALL remain unchanged

### Requirement: Surface settings are keyed by SurfaceId

`state/topic-settings.json` SHALL continue to use the dependency-provided canonical SurfaceId key space. A Surface's optional project assignment SHALL be stored as canonical `projectRoot`; absence SHALL mean personal. The record MUST NOT expose a mutable clear/switch operation or retain a pending notice claiming that an existing conversation's CWD changed.

#### Scenario: Canonical assignment is stored

- **WHEN** a Surface receives its first project assignment
- **THEN** its settings SHALL contain canonical `projectRoot`
- **AND** SHALL NOT contain legacy `projectDir` or `pendingProjectNotice`

#### Scenario: Unassigned Surface is personal

- **WHEN** no `projectRoot` exists for a Surface
- **THEN** its effective environment SHALL be personal

### Requirement: Legacy surface state migrates before polling

The filesystem migration module SHALL own one strict monotonic `stateVersion` and an ordered offline plan/apply registry. Only an absent version file SHALL mean version 0. Malformed JSON or schema, unreadable files, negative or non-integer values, and versions newer than the running code MUST fail before backup or persisted-input mutation. Startup SHALL require exact equality with `CURRENT_STATE_VERSION`, refuse to poll on mismatch, and name `bun run migrate` with the service stopped; it SHALL NOT execute filesystem conversion.

Surface conversion SHALL be canonical step 1, mapping version 0 to 1. Before altering any persisted input, the runner SHALL plan every pending step in order, with later planners consuming projected outputs from earlier plans. Any planning failure SHALL leave every step unapplied. The migration command SHALL then snapshot every persisted root named by those plans, preserving prior contents and path absence, before setup creates an optional snapshotted root. It SHALL apply plans in order and write each successor version only after that step succeeds. The command SHALL be the sole owner of the migration recovery backup; an unexpected apply failure requires whole-run backup restoration before retry and SHALL NOT rely on startup, mixed-generation loading, or an independent marker.

Step 1 SHALL parse and derive canonical replacements for legacy `bindings.json`, `topic-settings.json`, and schedule `locator` records before its applier writes. It SHALL validate every produced Surface and replace each JSON file through the existing atomic-write path. A legacy `topics` entry has no default container: planning SHALL require persisted evidence that uniquely and consistently proves `private` or `supergroup` for the same numeric topic, and SHALL fail when evidence is absent or conflicting. It SHALL NOT infer `direct-messages`. A legacy schedule SHALL use explicit legacy container metadata when present and otherwise SHALL be matched by both chat identity and captured Conversation/session ID against available bindings. A topic or schedule that cannot map to exactly one Surface SHALL fail without silently retargeting it.

`scripts/update.sh` SHALL stop Goblin before invoking the canonical migration command, perform no narrower duplicate migration backup, restart only after successful migration, and leave the service stopped when migration fails.

#### Scenario: Legacy bindings migrate without collisions

- **GIVEN** persisted state is at version 0
- **AND** `bindings.json` contains legacy `dm`, `topics`, `supergroups`, and `guest` entries
- **WHEN** the offline migration command applies step 1
- **THEN** each entry SHALL be converted to the corresponding canonical SurfaceId key
- **AND** every referenced session ID SHALL be preserved
- **AND** version 1 SHALL be written only after every step-1 output succeeds

#### Scenario: Legacy topic with explicit container evidence migrates

- **GIVEN** a legacy topic binding and its corroborating persisted record identify the same chat, topic, and session as a forum supergroup
- **WHEN** step 1 is planned
- **THEN** the binding SHALL map to `topic:supergroup`
- **AND** any matching topic setting or schedule SHALL use that same canonical SurfaceId

#### Scenario: Ambiguous legacy topic fails during preflight

- **GIVEN** a legacy topic binding or setting has no persisted container evidence, or its evidence conflicts
- **WHEN** the pending migration chain is planned
- **THEN** planning SHALL fail with the source path, chat ID, topic ID, and candidate canonical SurfaceIds
- **AND** no pending migration step SHALL be applied
- **AND** migration SHALL NOT default the topic to `supergroup`

#### Scenario: Legacy settings migrate

- **WHEN** `topic-settings.json` contains legacy DM, topic, and supergroup settings
- **THEN** each non-empty settings object SHALL be planned under the corresponding SurfaceId
- **AND** its `projectDir` and pending notice SHALL be unchanged by step 1

#### Scenario: Legacy schedule is inferred from its binding

- **WHEN** a legacy topicless schedule lacks an explicit kind
- **AND** its chat ID and session ID match exactly one DM, supergroup, or guest binding
- **THEN** step 1 SHALL plan that binding's SurfaceId without changing the schedule's owner, timing, prompt, state, or last-run metadata

#### Scenario: Ambiguous legacy schedule fails during preflight

- **WHEN** a legacy schedule matches zero or multiple candidate Surfaces
- **THEN** planning SHALL fail with a diagnostic identifying the schedule and candidates
- **AND** no pending migration step SHALL be applied

#### Scenario: Later-step failure prevents earlier-step mutation

- **GIVEN** persisted state is at version 0
- **AND** Surface step 1 has a valid plan
- **AND** environment step 2 detects an invalid project authority while consuming step 1's projected output
- **WHEN** the migration command preflights the pending 0-to-2 chain
- **THEN** step 1 SHALL NOT be applied
- **AND** `stateVersion` SHALL remain 0
- **AND** bindings, settings, schedules, workspace, and legacy workdir SHALL remain unchanged

#### Scenario: Invalid state version fails closed

- **WHEN** `state-version.json` is malformed, unreadable, has the wrong schema, contains a negative or non-integer value, or names a version newer than the running code
- **THEN** startup and the migration command SHALL fail with the invalid path and value/reason
- **AND** migration SHALL take no backup and mutate no persisted input

#### Scenario: Missing version alone means legacy version zero

- **WHEN** `state-version.json` is absent
- **THEN** the migration command SHALL treat persisted state as version 0
- **AND** no other read or parse failure SHALL receive that fallback

#### Scenario: Backup precedes setup mutation

- **GIVEN** a pending plan names an optional persisted root that does not yet exist
- **WHEN** the real migration CLI crosses its first mutation boundary
- **THEN** the recovery snapshot SHALL record that absence before any directory-creation helper runs
- **AND** restoring the backup SHALL remove paths created by the failed attempt

#### Scenario: Update leaves failed migration offline

- **WHEN** production update reaches filesystem migration
- **THEN** it SHALL stop Goblin before invoking the canonical backup/migration boundary
- **AND** a migration failure SHALL leave Goblin stopped
- **AND** only successful migration SHALL permit restart

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

### Requirement: Transcript provenance migration is conservative and offline

The canonical offline migration runner SHALL migrate legacy Conversation transcript provenance as filesystem step 3, after canonical Surface and execution-environment migration and before Conversation lifecycle migration. The transcript step SHALL precompute and validate every candidate rewrite before its first write, validate all existing fields through the transcript module, preserve line order and every existing field, and replace each changed transcript file atomically. `CURRENT_STATE_VERSION` SHALL advance from 2 to 3 only after the step succeeds.

The step SHALL preserve existing valid per-entry `sourceSurfaceId` and MAY add `sourceSurfaceId` only where persisted historical evidence proves one canonical event source. In this deployment the only such evidence is an entry's own existing valid per-entry provenance; no named historical-evidence store exists, and legacy `SessionState` carries only creation-time `chatId`/`topicId`. Conversation creation metadata alone, the current binding alone, shared chat numbers, shared memory scope, and shared Execution Environment SHALL NOT prove event-time provenance. If a whole legacy entry or file cannot be attributed without guessing, provenance SHALL remain absent. Existing valid per-entry provenance SHALL be preserved; invalid provenance SHALL remain non-authoritative and be reported through a bounded warning/count rather than rewritten to a guessed Surface. The step SHALL report a bounded count of legacy entries left with absent provenance without emitting transcript content. Non-`ENOENT` read/write errors and invalid transcript rewrites MUST fail the migration command before `stateVersion` advances.

The step SHALL run only through `bun run migrate` with the service stopped. It SHALL have no independent completion marker and SHALL NOT be required to accept mixed-generation files, resume after partial writes, or converge idempotently; recovery from failure restores the canonical migration command's backup.

#### Scenario: Existing valid per-entry provenance is preserved

- **WHEN** a legacy transcript entry already carries a canonical valid `sourceSurfaceId`
- **THEN** the offline step SHALL preserve that SurfaceId unchanged
- **AND** SHALL not alter any other field or line position

#### Scenario: Legacy entry without provenance stays null

- **GIVEN** a legacy transcript entry has no `sourceSurfaceId` and no historical evidence source exists
- **WHEN** the offline step runs
- **THEN** it SHALL leave `sourceSurfaceId` absent
- **AND** SHALL report the entry in a bounded unknown-provenance count without emitting transcript content
- **AND** SHALL not stamp any Surface derived from the current binding or creation metadata

#### Scenario: Current binding is not history

- **GIVEN** a legacy Conversation is currently bound to Surface Y
- **AND** its transcript entries have no event-time Surface evidence
- **WHEN** the offline step runs
- **THEN** it SHALL leave `sourceSurfaceId` absent
- **AND** SHALL not stamp Y across the transcript

#### Scenario: Version 2 deployment migrates

- **GIVEN** filesystem `stateVersion` is 2
- **WHEN** the operator runs `bun run migrate` with the service stopped
- **THEN** transcript provenance step 3 SHALL run exactly once
- **AND** `stateVersion` SHALL become 3 only after the step succeeds

#### Scenario: Startup sees pre-provenance state

- **WHEN** Goblin starts before the offline transcript step has advanced filesystem `stateVersion` to 3
- **THEN** startup SHALL refuse to poll
- **AND** SHALL direct the operator to run `bun run migrate` with the service stopped

### Requirement: Use distinct lifecycle terms

Goblin SHALL use **surface** for a stable Telegram delivery lane, **binding** for the current surface-to-conversation association, **conversation** for durable user-visible history, and **conversation runtime** for the in-memory runner and prompt queue serving a bound conversation. The term “session” SHALL remain only where it names pi's `AgentSession`, a compatibility symbol, or the legacy `state/sessions/` filesystem path.

#### Scenario: Durable history is described

- **WHEN** code, logs, diagnostics, or user-facing text refers to Goblin's persisted transcript and metadata
- **THEN** it SHALL call that object a conversation
- **AND** SHALL NOT call the Telegram surface or runtime a session

### Requirement: Export canonical Conversation persistence types

`src/sessions/mod.ts` SHALL export `ConversationId`, `ConversationState`, and the Conversation persistence interfaces used by orchestration. `Surface` and `SurfaceId` SHALL remain exported by the pure shared Surface module. `SessionManager` and `SessionState` MAY remain only as deprecated compatibility exports while callers migrate; obsolete public partial-binding methods MUST NOT remain.

#### Scenario: New caller imports Conversation persistence

- **WHEN** a new domain caller needs Conversation identity or persistence
- **THEN** it SHALL import canonical Conversation types/interfaces rather than `SessionState` or `ChatLocator`
- **AND** routing identity SHALL come from the shared Surface module

#### Scenario: Compatibility facade remains bounded

- **WHEN** a legacy caller temporarily imports `SessionManager` or `SessionState`
- **THEN** the export SHALL be marked as compatibility-only
- **AND** SHALL expose no operation that can add a second active binding for a Conversation

### Requirement: Conversation lifecycle is a deep module

The system SHALL expose one conversation-lifecycle interface that owns complete inspect, resolve-or-start, rotate, resume, and archive operations. Every binding-changing operation SHALL use the dependency-provided process-wide lifecycle-transition lock so unbound creation and cross-Surface moves cannot race. Callers SHALL NOT coordinate direct binding-file edits, conversation-record edits, and runtime disposal as separate lifecycle steps.

#### Scenario: Caller rotates a surface

- **WHEN** a caller requests rotation for a surface
- **THEN** the lifecycle module SHALL quiesce the prior runtime, create a fresh conversation in the surface's effective execution environment, update the binding, and return the resulting conversation
- **AND** the caller SHALL NOT perform any of those persistence steps itself

#### Scenario: Rotate quiescence fails before creation

- **GIVEN** a Surface is bound to Conversation P
- **WHEN** rotate invalidates P's runtime but required cleanup fails
- **THEN** no fresh Conversation SHALL be created
- **AND** the Surface SHALL remain bound to P
- **AND** the invalidated runtime object SHALL NOT be restored or reused
- **AND** a later turn MAY construct a fresh runtime for still-bound P

#### Scenario: Concurrent binding transitions serialize

- **WHEN** two operations would create, rotate, assign, or move bindings concurrently
- **THEN** each SHALL re-read authority while holding the shared transition lock
- **AND** one complete operation SHALL commit or fail before the other mutates persistence

#### Scenario: Caller inspects without mutation

- **WHEN** a caller inspects an unbound surface
- **THEN** the lifecycle module SHALL report that no conversation is bound
- **AND** SHALL NOT create a conversation or mutate persistence

#### Scenario: Archive storage move fails after unbinding

- **GIVEN** a Surface is bound to a Conversation whose runtime has quiesced
- **WHEN** archive atomically clears the binding but moving the Conversation directory fails
- **THEN** the lifecycle operation SHALL fail loudly
- **AND** the Conversation SHALL remain unbound, unarchived, and resumable
- **AND** the invalidated runtime SHALL NOT be restored

### Requirement: Authorized ordinary messages resolve or start conversations

The lifecycle module SHALL resolve the bound conversation for an authorized ordinary Telegram message and SHALL lazily create and bind a conversation when the message's surface is unbound. This behavior SHALL apply uniformly to every supported ordinary surface, including DMs. Slash commands other than explicit conversation-creation commands, scheduler ticks, internal jobs, and proactive delivery MUST use non-creating inspection.

#### Scenario: First ordinary DM message

- **WHEN** an authorized user sends ordinary content on an unbound DM surface
- **THEN** the system SHALL create a conversation using the surface's effective execution environment
- **AND** SHALL bind it before dispatching the content

#### Scenario: First ordinary topic message

- **WHEN** an authorized user sends ordinary content on an unbound topic surface
- **THEN** the same resolve-or-start operation SHALL create and bind a conversation

#### Scenario: Internal resolution does not create

- **WHEN** a scheduler tick, internal job, proactive delivery attempt, or status command inspects an unbound surface
- **THEN** no conversation SHALL be created

### Requirement: A conversation has at most one active binding

A non-archived conversation SHALL be actively bound to at most one surface. Resuming a conversation that is bound elsewhere SHALL atomically remove its prior binding and bind it to the destination; a conversation displaced from the destination SHALL remain stored, unarchived, and resumable.

#### Scenario: Resume moves a bound conversation

- **GIVEN** conversation A is bound to surface X
- **AND** conversation B is bound to surface Y
- **WHEN** A is resumed on Y
- **THEN** one atomic binding-file replacement SHALL leave A bound only to Y
- **AND** X SHALL be unbound
- **AND** B SHALL remain stored as an unbound resumable conversation

#### Scenario: Resume an already-current conversation

- **WHEN** the destination surface is already bound to the requested conversation
- **THEN** the lifecycle operation SHALL be idempotent
- **AND** SHALL NOT create, archive, or duplicate a binding

### Requirement: Resume requires execution-environment compatibility

The lifecycle module SHALL permit a conversation to bind to a destination surface only when the conversation's immutable execution environment equals the surface's effective execution environment. An incompatible attempt MUST fail before runtime disposal or binding mutation.

#### Scenario: Incompatible resume is rejected

- **GIVEN** a personal conversation and a project surface
- **WHEN** the user attempts to resume the personal conversation on the project surface
- **THEN** the operation SHALL report the environment mismatch
- **AND** all existing bindings and runtimes SHALL remain unchanged

#### Scenario: Matching project environment resumes

- **GIVEN** a conversation and destination surface that identify the same canonical project environment
- **WHEN** the conversation is resumed on the destination
- **THEN** the lifecycle module SHALL allow the move

### Requirement: Surface and conversation state have separate owners

Project assignment, model and thinking preferences, schedules, heartbeat enablement/interval, and the surface-specific heartbeat prompt SHALL be owned by `SurfaceId`. The current bound Surface SHALL be the sole routing input to the active memory-context projection; that projection is not a second persisted Surface setting and MUST NOT derive from Conversation creation metadata. Conversation ID, name, creation time, transcript, events, metrics, pi history, and immutable execution environment SHALL be owned by the Conversation. Rotating or resuming a Conversation MUST NOT copy, clear, disable, or duplicate Surface-owned state. Skill policy ownership is outside this change and remains defined by `surface-skill-policy`.

#### Scenario: Rotate preserves surface state

- **GIVEN** a Surface has project assignment, model and thinking preferences, enabled schedules, heartbeat configuration, and a memory context projected from its identity
- **WHEN** the surface rotates to a fresh conversation
- **THEN** all of those surface-owned values SHALL remain attached to the same `SurfaceId`
- **AND** the fresh conversation SHALL retain only its own conversation state

#### Scenario: Resume adopts destination preferences

- **GIVEN** a conversation moves from surface X to compatible surface Y
- **WHEN** its destination runtime is next created
- **THEN** the runtime SHALL use Y's model, thinking, automation, memory scope, tools, and delivery settings
- **AND** SHALL NOT carry X's surface-owned settings with it

### Requirement: Generate short conversation IDs

The lifecycle module SHALL generate 10-character lowercase hexadecimal conversation IDs from UUID v4, preserving the existing collision characteristics and filesystem-safe format.

#### Scenario: New conversation ID

- **WHEN** the lifecycle module creates a conversation
- **THEN** its ID SHALL contain exactly 10 lowercase hexadecimal characters

### Requirement: Persist surface heartbeat prompts

A surface-specific heartbeat prompt SHALL live at `$GOBLIN_HOME/state/surfaces/<SurfaceId>/HEARTBEAT.md`, resolved only through a path helper that first validates and canonicalizes the SurfaceId. The file belongs to the Surface and SHALL survive conversation rotation, movement, archive, and temporary unbinding. Reads SHALL return `null` only for `ENOENT`; other errors MUST propagate.

#### Scenario: Heartbeat prompt survives new

- **GIVEN** a Surface has a custom heartbeat prompt
- **WHEN** `/new` rotates its Conversation
- **THEN** the same Surface path SHALL supply the next heartbeat prompt

#### Scenario: Invalid SurfaceId is rejected

- **WHEN** the path helper receives an invalid, non-canonical, or traversal-bearing SurfaceId
- **THEN** it SHALL throw without returning a path outside `$GOBLIN_HOME/state/surfaces/`

### Requirement: Persist conversation records atomically in the legacy layout

Conversation state SHALL continue to live under `state/sessions/<conversationId>/` and SHALL be loaded and written through the JSON state-file module. Writes SHALL use atomic sibling-temp replacement; a missing `state.json` SHALL load as `null` so the Conversation is treated as missing. The stored conversation record MUST NOT use creation-time Telegram chat or topic fields as current routing state.

#### Scenario: Conversation record is saved

- **WHEN** conversation metadata is updated
- **THEN** `state/sessions/<conversationId>/state.json` SHALL be replaced atomically through the state-file module
- **AND** current routing SHALL be discoverable from bindings rather than `chatId` or `topicId` in that record

#### Scenario: Conversation record is missing

- **WHEN** the state-file module loads a Conversation whose `state.json` does not exist
- **THEN** it SHALL return `null`
- **AND** SHALL NOT manufacture default Conversation state

### Requirement: Create conversation filesystem layout

Creating a conversation SHALL create `state/sessions/<conversationId>/`, its pi-history and existing JSONL artifacts, and `state.json` without renaming the legacy directory tree.

#### Scenario: Conversation is created

- **WHEN** the lifecycle module starts a conversation
- **THEN** the existing transcript, events, metrics, pi-history, and state paths SHALL be initialized for that conversation ID

### Requirement: List resumable conversations by environment

The lifecycle module SHALL list non-archived conversations, including unbound conversations, sorted by creation time ascending (oldest first). A destination-aware listing SHALL include only conversations compatible with that surface's effective execution environment; internal conversations and `state/sessions/archive/` SHALL be excluded.

#### Scenario: Destination-aware list

- **WHEN** resumable conversations are listed for a project surface
- **THEN** only conversations with the same canonical project execution environment SHALL be returned
- **AND** unbound compatible conversations SHALL be included

#### Scenario: Missing conversation directory

- **WHEN** the legacy `state/sessions/` directory is absent
- **THEN** listing SHALL return an empty array without throwing

### Requirement: Persist Conversation names

The Conversation store SHALL set or clear an existing Conversation's optional name and persist the updated canonical record atomically. The legacy `title` field MAY remain as a compatibility storage name, but callers and user-visible behavior SHALL call it a Conversation name. Updating a missing Conversation MUST fail loudly.

#### Scenario: Conversation name is set

- **WHEN** the store sets Conversation `abc123def0`'s name to `memory refactor`
- **THEN** its canonical `state.json` SHALL persist that name atomically
- **AND** loading the Conversation SHALL return `memory refactor`

#### Scenario: Conversation name is cleared

- **WHEN** the store clears an existing Conversation's name
- **THEN** loading it SHALL return no name
- **AND** all other canonical Conversation fields SHALL remain unchanged

#### Scenario: Missing Conversation name update

- **WHEN** a caller tries to set or clear the name of a missing Conversation
- **THEN** the store SHALL throw `conversation not found`

### Requirement: Persist surface conversation preferences

The system SHALL persist optional model and thinking preferences in the surface-settings record keyed by canonical `SurfaceId`, using the dependency-provided atomic surface-settings storage. Updating either preference SHALL affect the current and future conversations on that surface without rewriting conversation state.

#### Scenario: Model preference survives rotation

- **WHEN** a surface's model preference is set and the conversation rotates
- **THEN** the surface-settings record SHALL retain the preference
- **AND** the next runtime on that surface SHALL use it

### Requirement: Migrate legacy lifecycle state offline

The canonical offline migration runner SHALL include lifecycle filesystem step 4, after transcript-provenance step 3, to convert legacy conversation records, bindings, model/thinking preferences, schedules, heartbeat records, and surface heartbeat prompt files to the split ownership model without deleting conversation history. The step SHALL compute and validate its complete transformation before its first write, then atomically replace each target file. It SHALL detect a conversation referenced by multiple surface bindings and fail with the conversation ID plus every candidate SurfaceId so the operator can choose the retained binding explicitly. Expected missing files may be skipped; invalid data and non-`ENOENT` filesystem errors MUST fail loudly. `CURRENT_STATE_VERSION` SHALL advance from 3 to 4 only after success. Startup MUST NOT invoke the step and SHALL rely on the canonical state-version gate.

#### Scenario: Legacy conversation has several bindings

- **GIVEN** one legacy conversation is referenced by several migrated surface bindings
- **WHEN** the offline lifecycle migration step computes its output
- **THEN** it SHALL fail before writing any lifecycle-step output
- **AND** the diagnostic SHALL identify the conversation and every candidate SurfaceId
- **AND** no binding SHALL be selected by lexical order, map order, or guessed recency
- **AND** the conversation directory and binding file SHALL remain unchanged

#### Scenario: Offline lifecycle migration succeeds

- **GIVEN** the service is stopped and the canonical migration command has backed up state
- **WHEN** the lifecycle step validates unambiguous legacy state and writes every computed output
- **THEN** conversation history SHALL remain present
- **AND** bindings, preferences, schedules, heartbeat records, and heartbeat prompt files SHALL have their canonical owners
- **AND** the canonical runner SHALL advance `stateVersion` only after the step succeeds

#### Scenario: Version 3 deployment migrates

- **GIVEN** filesystem `stateVersion` is 3
- **WHEN** the operator runs `bun run migrate` with the service stopped
- **THEN** lifecycle step 4 SHALL run exactly once
- **AND** `stateVersion` SHALL become 4 only after the step succeeds

#### Scenario: Startup sees the old state version

- **WHEN** Goblin starts before the lifecycle migration step has advanced `stateVersion` to 4
- **THEN** startup SHALL refuse to poll
- **AND** SHALL direct the operator to run `bun run migrate` with the service stopped

### Requirement: Scheduled turns stay bound to their captured Surface

A scheduled occurrence SHALL address its captured surface and resolve that surface's current binding non-mutatively at dispatch time. If the surface is unbound, the occurrence SHALL remain pending and enabled, SHALL NOT create a conversation, and SHALL be eligible on a later tick. If a conversation is bound, the scheduler SHALL dispatch through that conversation's current runtime without comparing against a creation-time conversation ID.

#### Scenario: Surface has a current conversation

- **WHEN** a schedule is due and its surface has a bound compatible conversation
- **THEN** the scheduler SHALL dispatch the prompt as a fresh turn through that conversation runtime

#### Scenario: Surface is temporarily unbound

- **WHEN** a schedule is due and inspection reports no binding
- **THEN** the scheduler SHALL leave the occurrence due and enabled
- **AND** SHALL NOT create a conversation or disable the schedule

### Requirement: Heartbeat schedule is explicit and Surface-owned

Heartbeat SHALL be an explicit, disabled-by-default, surface-owned schedule with a 30-minute default interval. Its prompt SHALL be resolved at dispatch time from the surface-specific heartbeat prompt, then `$GOBLIN_HOME/workspace/HEARTBEAT.md`, then the system constant; first non-whitespace content wins, trailing whitespace is stripped, leading whitespace is preserved, and the dispatched prompt begins with exactly one `[heartbeat]` marker. Non-`ENOENT` read errors MUST propagate and prevent that occurrence from dispatching. Rotating, resuming, archiving, or temporarily unbinding a conversation SHALL NOT disable or transfer the heartbeat.

#### Scenario: Heartbeat survives conversation rotation

- **GIVEN** heartbeat is enabled for a surface
- **WHEN** `/new` rotates that surface's conversation
- **THEN** the same heartbeat record and next-run state SHALL remain attached to the surface

#### Scenario: Unbound heartbeat remains pending

- **WHEN** heartbeat becomes due while its surface is unbound
- **THEN** no conversation SHALL be created
- **AND** the occurrence SHALL remain pending for the next bound conversation

#### Scenario: Prompt fallback uses surface configuration

- **WHEN** a due heartbeat's surface-specific prompt contains non-whitespace text
- **THEN** that text SHALL be used without consulting the global file
- **AND** the prompt SHALL begin with exactly one `[heartbeat]` marker

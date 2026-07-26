# sessions

## ADDED Requirements

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

### Requirement: Resolve sessions from complete Surface values

`SessionManager.resolve(surface)` SHALL accept a complete `Surface` with no routing options. An unbound DM SHALL return `null` until explicitly created. Topic surfaces of every container, topicless supergroups, and guest surfaces SHALL auto-create on first resolve. Existing bindings SHALL return their session state. A stale DM binding SHALL be warned, removed, and return `null`; stale auto-creating surface bindings SHALL be warned and replaced with a newly created session. These identity changes SHALL preserve the existing session-creation and stale-binding behavior.

#### Scenario: Unbound DM remains explicit-create

- **WHEN** `resolve()` receives an unbound `{ kind: "dm", chatId }` surface
- **THEN** it SHALL return `null`
- **AND** SHALL NOT create a session

#### Scenario: Bound DM resolves

- **WHEN** `resolve()` receives a DM surface with a live binding
- **THEN** it SHALL return the bound session state

#### Scenario: Any topic container auto-creates

- **WHEN** `resolve()` receives an unbound topic surface whose container is `private`, `supergroup`, or `direct-messages`
- **THEN** it SHALL create and bind a new session for that exact surface
- **AND** the new `state.json` SHALL NOT contain `projectDir`

#### Scenario: Topicless supergroup auto-creates

- **WHEN** `resolve()` receives an unbound topicless supergroup surface
- **THEN** it SHALL create and bind a new session

#### Scenario: Guest auto-creates

- **WHEN** `resolve()` receives an unbound guest surface
- **THEN** it SHALL create and bind a new session without requiring `/new`

#### Scenario: Stale DM is cleared

- **WHEN** a DM binding points to a missing `state.json`
- **THEN** `resolve()` SHALL log a warning, remove that SurfaceId entry atomically, and return `null`

#### Scenario: Stale auto-creating surface is repaired

- **WHEN** a topic, topicless supergroup, or guest binding points to a missing `state.json`
- **THEN** `resolve()` SHALL log a warning, create a new session, replace that exact SurfaceId binding, and return the new state

### Requirement: Surface-based creation and rebinding preserve conversation identity

The session manager SHALL provide `createForSurface(surface, options?)` and `bindExistingToSurface(sessionId, surface)`. Creating for a surface SHALL create a new session and update only that surface's binding; any displaced session directory SHALL remain intact and resumable. Binding an existing session SHALL update only the destination binding without rewriting the session's historical `chatId` or `topicId`. Surface routing identity SHALL remain a binding concern, separate from the durable session identity.

#### Scenario: Create a new DM session

- **WHEN** `createForSurface(dmSurface)` is called for an already-bound DM
- **THEN** it SHALL create a session with a new ID
- **AND** point only the DM surface binding at the new ID
- **AND** leave the previous session directory intact

#### Scenario: Create for a topic uses its full identity

- **WHEN** `createForSurface(topicSurface)` is called
- **THEN** it SHALL bind the session under the topic's container-aware SurfaceId

#### Scenario: Bind an existing session

- **WHEN** `bindExistingToSurface(sessionId, surface)` is called for a live session
- **THEN** it SHALL bind that exact surface to the existing session without creating another session
- **AND** any displaced session SHALL remain stored and resumable

#### Scenario: Missing session cannot be bound

- **WHEN** `bindExistingToSurface()` receives a missing session ID
- **THEN** it SHALL throw `session not found`

### Requirement: Peek binding is complete and non-mutating

`SessionManager.peekBinding(surface)` SHALL accept a complete `Surface`, read only the binding at its canonical SurfaceId, and return its session ID and state when both exist. It SHALL return `null` for absent or stale bindings and SHALL never create, repair, or infer another surface binding.

#### Scenario: Exact binding is returned

- **WHEN** `peekBinding(surface)` is called for a live binding
- **THEN** it SHALL return that binding's session ID and state

#### Scenario: Similar surface is not substituted

- **WHEN** only a guest binding exists for a numeric chat ID
- **AND** `peekBinding()` is called with a DM surface carrying the same number
- **THEN** it SHALL return `null`

#### Scenario: Peek never auto-creates

- **WHEN** `peekBinding()` is called for an unbound topic, supergroup, or guest surface
- **THEN** it SHALL return `null`
- **AND** SHALL NOT write bindings or session files

### Requirement: Surface settings are keyed by SurfaceId

`state/topic-settings.json` SHALL persist per-surface settings in one `surfaces` map keyed by canonical `SurfaceId`. `SessionManager.getProjectDir(surface)`, `bindProjectDir(surface, projectDir)`, and `consumeProjectNotice(surface)` SHALL accept complete surfaces and access only the corresponding key. They SHALL preserve the current project-directory and pending-notice behavior and atomic-write guarantees. Settings for numerically similar surface kinds and topic containers SHALL not collide.

#### Scenario: Read and write project directory

- **WHEN** `bindProjectDir(surface, "/home/daniel/project")` is called
- **THEN** `topic-settings.json` SHALL store that value under `surfaceId(surface)`
- **AND** `getProjectDir(surface)` SHALL return it

#### Scenario: Clear project directory

- **WHEN** `bindProjectDir(surface, undefined)` is called
- **THEN** the project directory SHALL be removed from that surface's settings
- **AND** an empty settings record SHALL be pruned

#### Scenario: Similar surfaces keep separate settings

- **WHEN** two surfaces share numeric identifiers but differ in kind or topic container
- **THEN** setting a project directory for one SHALL NOT change the other

#### Scenario: Pending notice uses the same key

- **WHEN** a project notice is queued and consumed for a surface
- **THEN** it SHALL be read and cleared only from that surface's canonical settings record

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

## MODIFIED Requirements

### Requirement: Generate short session IDs

The system SHALL generate 10-character lowercase hexadecimal session IDs from UUID v4, providing approximately 1.1 trillion combinations.

#### Scenario: New session created for a surface

- **WHEN** `createForSurface()` creates a session
- **THEN** the resulting session SHALL have an ID of exactly 10 lowercase hexadecimal characters

### Requirement: Create session filesystem layout

The system SHALL create the complete existing filesystem layout when creating a session for a surface. The identity migration SHALL NOT rename or relocate session directories.

#### Scenario: Session created

- **WHEN** `createForSurface()` creates a session
- **THEN** it SHALL create `state/sessions/<id>/`, `workdir/`, `events.jsonl`, `transcript.jsonl`, and `state.json` as before

### Requirement: Export session types and manager

The system SHALL export `SessionManager` and `SessionState` from `src/sessions/mod.ts`. The obsolete `ChatLocator` SHALL no longer be exported; Telegram-native `Surface` and `SurfaceId` SHALL be defined by the pure shared surface module so sessions and orchestration can consume them without importing Telegram adapters.

#### Scenario: Session module import

- **WHEN** a module imports from `"./sessions/mod.ts"`
- **THEN** it SHALL have access to `SessionManager` and `SessionState`
- **AND** it SHALL use the shared surface module for surface identity types

### Requirement: Topic settings file

The system SHALL maintain `state/topic-settings.json` under `$GOBLIN_HOME` as a canonical SurfaceId-keyed settings file containing values such as `projectDir` and pending project notice. It SHALL load and save through the JSON state-file module, use an empty canonical settings structure when missing or malformed, and propagate non-`ENOENT`, non-`SyntaxError` failures. All slot selection SHALL use `surfaceId(surface)` and SHALL NOT infer DM versus supergroup from numeric sign.

#### Scenario: Load canonical settings

- **WHEN** the file contains valid canonical settings
- **THEN** the loader SHALL return the SurfaceId-keyed structure via `loadJsonFile`

#### Scenario: Missing or malformed settings

- **WHEN** the file is missing or malformed
- **THEN** the loader SHALL return an empty canonical settings structure
- **AND** malformed JSON SHOULD emit a warning

#### Scenario: Non-JSON error propagates

- **WHEN** reading the file fails for a reason other than absence or malformed JSON
- **THEN** the error SHALL propagate

### Requirement: Persist scheduled turn definitions

The system SHALL persist scheduled turns atomically under `$GOBLIN_HOME`. Each in-memory schedule SHALL carry a complete captured `Surface`; the on-disk schedule record SHALL store its canonical `SurfaceId` rather than a partial locator. Existing schedule ID, session owner, kind, enabled/state fields, timing, recurrence, prompt, source, creation time, and last-run metadata SHALL remain unchanged.

#### Scenario: Schedule persisted with canonical surface identity

- **WHEN** a one-shot, recurring, or heartbeat schedule is created for an active session
- **THEN** the store SHALL persist `surfaceId(surface)` with the schedule
- **AND** SHALL NOT persist a legacy `locator` or separate routing flag

#### Scenario: Schedule round-trips

- **WHEN** a canonical schedule store is reloaded
- **THEN** each SurfaceId SHALL decode to the original complete surface before the schedule is returned to callers

#### Scenario: Invalid persisted surface fails loudly

- **WHEN** a schedule contains an invalid or unknown SurfaceId
- **THEN** loading SHALL fail with the schedule ID and validation error
- **AND** SHALL NOT dispatch or silently drop the schedule

### Requirement: Scheduled turns stay bound to their captured session surface

A scheduled turn SHALL run only when its captured session ID is still the active binding for its captured complete `Surface`. Validation SHALL call non-mutating `SessionManager.peekBinding(surface)` and SHALL NOT call `resolve(surface)`. A mismatch or archived session SHALL preserve the existing disable and last-run behavior. Dispatch SHALL pass the decoded complete surface to orchestration and Telegram delivery.

#### Scenario: Captured binding still matches

- **WHEN** a due schedule's exact SurfaceId still binds its captured session ID
- **THEN** the scheduler SHALL dispatch a fresh turn with the decoded surface

#### Scenario: Similar surface does not satisfy validation

- **WHEN** the captured surface is a guest surface
- **AND** only a DM or supergroup with the same numeric chat ID is bound to the session
- **THEN** validation SHALL treat the schedule as a binding mismatch
- **AND** SHALL NOT dispatch it

#### Scenario: Captured binding no longer matches

- **WHEN** `peekBinding(surface)` returns no session or a different session
- **THEN** the scheduler SHALL disable the schedule, record `binding-mismatch`, and SHALL NOT prompt the old session

#### Scenario: Archived captured session

- **WHEN** the captured session is archived and its surface binding has been cleared
- **THEN** the scheduler SHALL disable the schedule, record `archived`, and SHALL NOT auto-create or resume a session

## REMOVED Requirements

### Requirement: Resolve DM sessions only when explicitly bound

### Requirement: Auto-create sessions for topics on first resolve

### Requirement: Handle stale bindings for DMs

### Requirement: Handle stale bindings for topics by recreating

### Requirement: Support session rebinding for DMs

### Requirement: Bind existing sessions to chat surfaces

### Requirement: Session rebinding leaves old session resumable

### Requirement: Get projectDir from binding

### Requirement: Bind projectDir to chat surface

### Requirement: Guest session bindings keyed on foreign chat id

### Requirement: Auto-create guest sessions on first resolve

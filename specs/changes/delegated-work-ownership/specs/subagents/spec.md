# subagents

## ADDED Requirements

### Requirement: Current subagent invocations are attached delegated work

Every newly spawned generic or named subagent invocation SHALL be classified in code as `attached`; the `spawn_subagent` and `revive_subagent` schemas MUST NOT expose a lifetime selector. A top-level invocation SHALL capture the owning `ConversationId`, exact creating runtime identity, immutable Execution Environment, `originSurfaceId`, and the runtime's already-resolved active memory context before execution begins.

A subagent invocation belongs to that captured runtime ownership epoch even when its pi history is persisted. A replacement runtime for the same Conversation MUST NOT adopt an in-flight invocation. Runtime invalidation SHALL cancel or terminally invalidate the complete invocation tree before the lifecycle transition commits.

#### Scenario: Generic spawn captures attached authority

- **WHEN** a current Conversation runtime spawns a generic subagent
- **THEN** the invocation SHALL record `lifetime: "attached"`, its owner Conversation, runtime identity, origin Surface, Execution Environment, and active memory context
- **AND** none of those values SHALL be accepted from model tool input

#### Scenario: Named spawn is also attached

- **WHEN** a current Conversation runtime spawns a named subagent
- **THEN** it SHALL receive the same attached ownership fields as a generic subagent
- **AND** named-agent prompt, isolated skill, and persona-memory behavior SHALL remain unchanged

#### Scenario: Replacement runtime does not adopt invocation

- **GIVEN** attached subagent A was created by runtime R1 for Conversation C
- **WHEN** R1 is invalidated and runtime R2 is later created for C
- **THEN** A SHALL be cancelled or terminally invalidated with R1
- **AND** R2 SHALL NOT receive A's late result or callbacks

### Requirement: Recursive subagents inherit the root attached ownership epoch

Every recursively spawned child SHALL inherit the root invocation's `ownerConversationId`, creating runtime identity, `lifetime: "attached"`, immutable Execution Environment, `originSurfaceId`, and active memory context. The parent-child `spawnedBy` chain SHALL remain the ancestry mechanism for depth enforcement and recursive cleanup, but it MUST NOT replace the root ownership fields or re-resolve authority through a current binding, Surface setting, or CWD.

Runtime invalidation SHALL synchronously fence new child creation for the entire tree, mark every running descendant for cancellation before awaiting cleanup, start descendant aborts without parent/child deadlock, and report failure if the tree cannot be proven quiescent. Terminal ancestors SHALL remain in the traversal so a running descendant cannot escape cleanup.

#### Scenario: Child inherits root authority

- **GIVEN** subagent A is attached to runtime R with project environment P and origin Surface X
- **WHEN** A spawns child B
- **THEN** B SHALL record the same owner Conversation, R, P, X, and active memory context
- **AND** only B's subagent id, parent id, depth, role, and invocation-local state MAY differ

#### Scenario: Runtime invalidation cancels descendants through terminal parent

- **GIVEN** root subagent A is terminal and descendant B is still running under the same ownership epoch
- **WHEN** the creating runtime is invalidated
- **THEN** traversal SHALL retain A as ancestry and cancel B
- **AND** the tree SHALL not be reported quiescent until B's execution can no longer produce effects

#### Scenario: Child spawn loses race with invalidation

- **WHEN** runtime invalidation fences an attached tree while a parent attempts to spawn a child
- **THEN** the spawn SHALL fail before creating metadata or a pi session
- **AND** invalidation SHALL NOT miss newly created work

### Requirement: Subagent control is scoped to the owner Conversation

User-visible list, inspect, revive, and explicit cancel operations SHALL authorize subagent history or active invocations by `ownerConversationId`. A caller from another Conversation SHALL receive the same not-found result as an unknown subagent even if it knows the id, is bound to the origin Surface, or has an equal Execution Environment. Internal runtime invalidation MAY cancel by the exact runtime ownership epoch without pretending to be user control.

#### Scenario: Cross-Conversation subagent control is hidden

- **GIVEN** subagent A belongs to Conversation C1
- **WHEN** Conversation C2 attempts to inspect, revive, or cancel A
- **THEN** the operation SHALL report not found
- **AND** SHALL NOT reveal A's owner, origin Surface, environment, role, or status

#### Scenario: Moved owner can revive history

- **GIVEN** Conversation C owns completed subagent history and later moves from Surface X to compatible Surface Y
- **WHEN** C explicitly revives that subagent from its current runtime on Y
- **THEN** owner authorization SHALL succeed
- **AND** the new invocation SHALL capture the current runtime epoch and Y as its origin without mutating the completed prior invocation's audit state

## MODIFIED Requirements

### Requirement: Subagent sessions persist to disk

Every subagent spawn SHALL create a persisted pi session in the existing location: generic subagents under `$GOBLIN_HOME/scratch/subagents/<id>/` and named subagents under `$GOBLIN_HOME/workspace/agents/<name>/instances/<id>/`. Atomic `meta.json` SHALL retain existing id, role, name, `spawnedBy`, depth, timestamps, status, and memory fields and SHALL additionally record the current invocation's `ownerConversationId`, exact runtime identity, code-owned `lifetime: "attached"`, immutable Execution Environment, `originSurfaceId`, and ownership-epoch id.

The active memory context persisted for revival SHALL be the value captured from the creating runtime; it MUST NOT be recomputed from the Conversation's later binding. Ownership metadata is authority and SHALL be validated at the persistence boundary rather than cast from disk.

#### Scenario: Generic metadata records ownership

- **WHEN** a generic subagent is spawned
- **THEN** its existing `session.jsonl` and atomic `meta.json` artifacts SHALL be created
- **AND** `meta.json` SHALL contain the complete attached ownership epoch

#### Scenario: Named metadata records ownership

- **WHEN** a named subagent is spawned
- **THEN** its instance directory and pi history SHALL remain under the named-agent tree
- **AND** its metadata SHALL contain the same ownership fields without weakening named skill or persona isolation

#### Scenario: Malformed ownership metadata is rejected

- **WHEN** persisted non-legacy metadata has an invalid owner Conversation, runtime identity, lifetime, SurfaceId, or Execution Environment
- **THEN** load or revival SHALL fail before starting pi or rewriting metadata

### Requirement: Subagent revival loads persisted session

`revive(id, prompt, runtimeContext)` SHALL load the persisted pi history and continue it only after authorizing the caller's current `ConversationId` against the stored owner. Revival SHALL create a fresh ownership-epoch id and a new attached invocation under the reviving Conversation runtime, capturing that runtime's identity, origin Surface, immutable environment, and active memory context. It MUST NOT reactivate the prior runtime identity, retain its callbacks, or treat persisted history as a still-running invocation.

A terminal legacy metadata record without ownership fields MAY be revived once by an authorized current Conversation; that revival SHALL validate the history and environment, stamp a fresh complete ownership epoch atomically, and SHALL NOT enqueue the historical result as pending completion. Existing valid owner metadata MUST NOT be reassigned to another Conversation.

#### Scenario: Revive creates a new attached epoch

- **GIVEN** subagent history completed under runtime R1
- **WHEN** its owning Conversation revives it under runtime R2
- **THEN** the persisted pi history SHALL be reused
- **AND** the invocation SHALL be attached to R2 with a new ownership-epoch id
- **AND** invalidating R1 SHALL have no effect on the new invocation

#### Scenario: Legacy terminal history is revived without backfill

- **GIVEN** a pre-migration terminal subagent record has no owner or delivery metadata
- **WHEN** an authorized Conversation revives it successfully
- **THEN** the new invocation SHALL atomically receive complete attached ownership from the reviving runtime
- **AND** the old terminal output SHALL NOT become a pending notification

#### Scenario: Existing owner cannot be reassigned

- **GIVEN** persisted subagent history records owner Conversation C1
- **WHEN** C2 attempts revival
- **THEN** revival SHALL return not found
- **AND** SHALL NOT rewrite metadata or open the pi session

### Requirement: Subagent results returned to caller

When an attached subagent completes while its creating runtime remains current, its final output SHALL be returned through the existing blocking tool call to its direct spawner, and parent subagents SHALL continue to receive child results through the same contract. This direct accepted return SHALL count as delivered and SHALL NOT create a pending-completion record.

If runtime invalidation wins before result acceptance, the invocation SHALL be cancelled or terminally invalidated, the blocking tool call SHALL reject or abort, and no late result, status callback, or Telegram sink invocation MAY reach the replacement runtime. This change MUST NOT invent detached or durable subagent delivery.

#### Scenario: Current caller receives result

- **WHEN** a subagent completes and its ownership runtime is still current
- **THEN** its final response SHALL be returned to the direct caller
- **AND** no pending delivery SHALL be queued

#### Scenario: Invalidation wins completion race

- **WHEN** runtime invalidation and subagent completion race
- **THEN** exactly one result-acceptance or cancellation transition SHALL win
- **AND** a result not accepted by the valid caller SHALL NOT be delivered later to another runtime

### Requirement: Cancel subagent aborts execution

Explicit `cancel(id, ownerConversationId)` SHALL authorize the caller by owner Conversation, synchronously claim cancellation for the current invocation, abort its pi session, persist terminal cancellation, tear down callbacks, and recursively cancel running descendants in the same ownership epoch. Repeated cancellation of a terminal invocation SHALL remain idempotent. An unauthorized or nonexistent id SHALL return the same `Subagent not found` error.

Runtime invalidation SHALL use the exact runtime identity rather than this user-control method and SHALL propagate cleanup failures to `DelegatedWorkHost` so lifecycle code can require quiescence.

#### Scenario: Owner cancels running tree

- **WHEN** the owning Conversation explicitly cancels a running root subagent
- **THEN** the root and every running descendant in its ownership epoch SHALL be aborted and persisted as cancelled
- **AND** cleanup SHALL be attempted for every target even if one target fails

#### Scenario: Other Conversation cannot cancel

- **WHEN** a different Conversation calls cancel with the subagent id
- **THEN** it SHALL receive `Subagent not found`
- **AND** the invocation SHALL continue unchanged

#### Scenario: Repeated cancellation is idempotent

- **WHEN** owner cancellation races runtime invalidation
- **THEN** exactly one cancellation claim SHALL win for each invocation
- **AND** pi abort and callback teardown SHALL run at most once per invocation

### Requirement: Spawn rejects children of cancelled parents

`SubagentRunner.spawn()` SHALL reject a child when its parent invocation is not running, when the root ownership epoch has been fenced for runtime invalidation, or when supplied inherited authority differs from the root. Rejection SHALL happen before metadata or pi-session creation. A running parent under an unfenced epoch MAY spawn subject to the existing recursion-depth cap.

#### Scenario: Child spawn rejected after runtime fence

- **WHEN** a parent still appears running locally but its creating runtime epoch has been fenced
- **THEN** child spawn SHALL fail before persistence

#### Scenario: Child authority mismatch is rejected

- **WHEN** a recursive spawn attempts to substitute another owner, runtime, origin Surface, environment, or memory context
- **THEN** the spawn SHALL fail
- **AND** no child SHALL be created

#### Scenario: Valid running parent may spawn

- **WHEN** a running parent under an unfenced attached epoch spawns within the depth limit
- **THEN** the child SHALL be created with inherited root authority

## REMOVED Requirements

### Requirement: Cascade cancel aborts all subagents for a session

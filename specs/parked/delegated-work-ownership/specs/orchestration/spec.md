# orchestration

## ADDED Requirements

### Requirement: DelegatedWorkHost owns cross-run lifecycle policy

Orchestration SHALL expose one `DelegatedWorkHost` as the deep module that owns delegated-run registration, runtime invalidation, Conversation-scoped control, and pending-completion claims across subagent and external-agent adapters. Callers MUST NOT enumerate runners, compare CWDs, inspect adapter record shapes, or coordinate per-run cancellation themselves.

Every registered invocation SHALL identify its `ownerConversationId`, code-owned lifetime, immutable Execution Environment, and `originSurfaceId`. Attached invocations SHALL additionally identify the exact creating Conversation runtime. The host SHALL reject a registration whose owner, runtime, Surface, or environment authority is missing or inconsistent before execution starts.

`invalidateRuntime(runtimeId)` SHALL be the single runtime-lifecycle operation. `cancelByConversation(ownerConversationId)` SHALL be a separate explicit user-control operation and SHALL destructively cancel both attached and durable non-terminal work owned by that Conversation. Run-specific inspection, continuation, and cancellation SHALL authorize by `ownerConversationId`; neither the current binding, `originSurfaceId`, nor Execution Environment equality grants control.

#### Scenario: Runtime invalidation uses one host operation

- **WHEN** the Conversation lifecycle invalidates runtime R
- **THEN** it SHALL call `DelegatedWorkHost.invalidateRuntime(R)` once
- **AND** SHALL NOT call subagent and external-agent `cancelBySession` methods independently

#### Scenario: Owning Conversation explicitly cancels all work

- **GIVEN** Conversation A owns one attached invocation and one durable invocation
- **WHEN** an authorized explicit cancel flow calls `cancelByConversation(A)`
- **THEN** the host SHALL attempt destructive cancellation of both invocations
- **AND** SHALL wait for each adapter's required quiescence or report that quiescence could not be proven

#### Scenario: Equal CWD grants no control

- **GIVEN** Conversations A and B have equal project Execution Environments
- **AND** A owns a delegated run
- **WHEN** B attempts to inspect, continue, or cancel that run
- **THEN** the operation SHALL return the same not-found result used for an unknown run
- **AND** SHALL NOT disclose or mutate A's run

#### Scenario: Moved owner retains explicit control

- **GIVEN** Conversation A owns a durable run created on Surface X
- **WHEN** A is moved to Surface Y
- **THEN** A MAY explicitly inspect, continue, or cancel the run from Y
- **AND** those control operations SHALL NOT change the run's origin Surface or pending-delivery destination

### Requirement: Pending delegated completions are claimed only on the origin Surface

When a durable run reaches a terminal outcome that was not already delivered by a blocking caller or explicitly suppressed by cancellation, the delegated-work subsystem SHALL atomically retain a bounded pending-completion record keyed to the run's immutable `originSurfaceId`. The record SHALL contain only bounded delivery material and a reference to the canonical run result; terminal execution state and delivery state SHALL remain independent.

Only the next authorized ordinary interaction whose normalized `SurfaceId` exactly equals the origin MAY claim pending completions. Claiming SHALL be bounded per interaction and atomic so concurrent interactions cannot inject the same completion. Pending-completion lookup MUST NOT call Conversation `resolveOrStart`, create a Conversation, synthesize a runtime, send a background Telegram message, or choose another Surface. Ordinary-message handling MAY independently create a Conversation under the existing lifecycle contract before offering the claim to its resulting current runtime.

A claimed completion SHALL become delivered only after current-runtime dispatch accepts the bounded completion into that authorized interaction. If dispatch rejects it, the stale-runtime guard wins, or failure occurs before acceptance, the claim SHALL be released to pending. Startup SHALL release abandoned in-progress claims without duplicating an already acknowledged delivery. No matching authorized interaction means the completion remains pending and proactive contact remains suspended.

#### Scenario: Ordinary interaction claims completion on exact origin

- **GIVEN** a durable run from Surface X is terminal with pending delivery
- **WHEN** an authorized ordinary interaction arrives on X and its current runtime accepts dispatch
- **THEN** the turn SHALL receive the bounded completion context
- **AND** the delivery SHALL be marked delivered after acceptance

#### Scenario: Pending lookup does not create a Conversation

- **GIVEN** Surface X is unbound and has a pending delegated completion
- **WHEN** orchestration checks pending completions without an authorized ordinary message
- **THEN** it SHALL leave X unbound and the completion pending
- **AND** SHALL NOT invoke Conversation creation or send Telegram output

#### Scenario: Ordinary creation authority remains separate

- **GIVEN** unbound Surface X has a pending completion
- **WHEN** an authorized ordinary message arrives on X
- **THEN** the existing ordinary-message lifecycle MAY create X's Conversation
- **AND** the pending-completion subsystem SHALL only claim after receiving the resulting authorized dispatch context
- **AND** the pending record itself SHALL NOT be the cause of Conversation creation

#### Scenario: Dispatch rejection releases claim

- **GIVEN** an interaction on X claims a pending completion
- **WHEN** its captured runtime becomes stale before accepting the injected context
- **THEN** the completion SHALL return to pending
- **AND** a later authorized ordinary interaction on X MAY claim it

#### Scenario: Equal environment is not a fallback destination

- **GIVEN** a completion is pending for unavailable Surface X
- **AND** Surface Y has the same canonical CWD or owns the same Conversation
- **WHEN** Y receives an interaction
- **THEN** Y SHALL NOT claim or receive X's pending completion automatically
- **AND** contact for X SHALL remain suspended

#### Scenario: Guest requires a later summon on the same guest Surface

- **GIVEN** a run originated from guest Surface G and completes after its one-shot reply opportunity ended
- **WHEN** another Surface interacts or no guest summon is active
- **THEN** the completion SHALL remain pending
- **AND** only a later authorized guest summon whose canonical `SurfaceId` equals G MAY claim it

#### Scenario: Concurrent origin interactions do not duplicate delivery

- **GIVEN** Surface X has one pending completion
- **WHEN** two authorized ordinary interactions on X race to claim it
- **THEN** at most one interaction SHALL receive that completion claim
- **AND** the other SHALL proceed without a duplicate injection

### Requirement: External-agent runs follow Goblin Conversation lifecycle

The composition root SHALL construct one shared external-agent runner and register its adapter with `DelegatedWorkHost`. Newly started ACP runs SHALL be durable under code-owned policy. Conversation runtime disposal caused by `/new`, `/resume`, `/archive`, `/project`, or rebinding SHALL detach those runs from stale runtime callbacks without cancelling them. Existing migrated non-terminal external runs SHALL remain attached and SHALL be destructively quiesced when their recorded compatibility runtime is invalidated.

Explicit user interrupt/cancel for the owning Conversation SHALL call `cancelByConversation(ownerConversationId)` and remain destructive for both lifetimes. Startup SHALL initialize and reconcile the shared external runner after preflight and before polling or any new external start; a non-terminal ACP record lacking valid clean-detach proof SHALL block that boundary under the accepted ACP boot-id and cleanup rules.

Graceful process shutdown SHALL stop the scheduler first, invoke and await the external runner's detach-aware `shutdown()`, then attempt pi-subagent disposal, main-runner disposal, and Telegram shutdown. Resumable ACP work survives only after clean local teardown proof, while non-resume-eligible work becomes interrupted after cleanup. External startup/shutdown failures SHALL be logged with bounded run identifiers and without ACP session IDs, tasks, output, or environment values; an external shutdown failure MUST NOT skip the remaining independent shutdown steps. Conversation-lifecycle durability MUST NOT bypass ACP deadline, stopping, cleanup, boot-id, fingerprint, or resume-eligibility rules.

#### Scenario: Startup reconciles before polling

- **WHEN** Goblin starts with persisted non-terminal external-agent records
- **THEN** the shared runner SHALL reconcile them after preflight and before Telegram polling or new external starts
- **AND** unresolved same-boot hard-crash uncertainty SHALL block that boundary with a bounded diagnostic

#### Scenario: Graceful shutdown preserves accepted ordering

- **WHEN** Goblin receives SIGINT or SIGTERM
- **THEN** it SHALL stop the scheduler before awaiting detach-aware external shutdown
- **AND** SHALL then attempt pi-subagent disposal, main-runner disposal, and Telegram shutdown

#### Scenario: External shutdown failure does not skip cleanup

- **WHEN** external-runner shutdown fails
- **THEN** Goblin SHALL log the failure without task, output, ACP session ID, or environment values
- **AND** SHALL still attempt every remaining independent shutdown step

#### Scenario: New ACP run survives Conversation rotation

- **WHEN** a newly started durable ACP run is active and its owner Conversation rotates, moves, archives, or changes through `/project`
- **THEN** runtime invalidation SHALL NOT call destructive ACP cancellation for that run
- **AND** the run SHALL keep its original owner, origin Surface, and Execution Environment

#### Scenario: Explicit Conversation cancellation is destructive

- **WHEN** the user explicitly cancels delegated work for the owning Conversation
- **THEN** durable ACP prompts, ACP sessions when appropriate, terminals, and server processes SHALL receive the existing destructive cleanup
- **AND** a cancelled resumable run SHALL NOT be resumed on startup

#### Scenario: Conversation durability does not imply process resumability

- **GIVEN** a durable ACP run uses a server definition that is not resume-eligible
- **WHEN** Goblin shuts down
- **THEN** the run SHALL follow ACP's non-resumable interruption and cleanup contract
- **AND** its durable Conversation lifetime SHALL NOT cause task replay or invented resume support

## MODIFIED Requirements

### Requirement: Runtime disposal precedes binding movement

Before rotate, resume, archive, or `/project` commits a binding or environment-authority change, orchestration SHALL synchronously invalidate every stale Conversation runtime and sever its prompt queue. It SHALL then call the single `DelegatedWorkHost.invalidateRuntime(runtimeId)` operation and await proof that all attached work in that runtime's complete delegation tree is terminal or otherwise quiescent. Only after runtime disposal and attached-work quiescence succeed MAY the lifecycle commit its binding transition.

Runtime invalidation SHALL detach durable work from stale status callbacks, turn sinks, Telegram adapters, and runtime objects without cancelling the durable run. A durable run MUST NOT retain a callback or sink owned by the invalid runtime. Failure to prove attached quiescence or durable callback detachment SHALL fail the lifecycle operation before binding mutation; deleting an in-memory map entry or timing out cleanup is not proof of quiescence.

#### Scenario: Rotate waits for attached tree

- **GIVEN** runtime R owns a running attached subagent tree
- **WHEN** `/new` invalidates R
- **THEN** orchestration SHALL cancel and await the complete tree through `DelegatedWorkHost`
- **AND** SHALL NOT commit the new binding until the tree is proven quiescent

#### Scenario: Durable ACP run survives rotation

- **GIVEN** runtime R started a durable ACP run
- **WHEN** `/new`, `/resume`, `/archive`, or `/project` invalidates R
- **THEN** the run SHALL continue under its captured owner, origin Surface, and Execution Environment
- **AND** every callback or Telegram sink from R SHALL be detached before the lifecycle transition commits

#### Scenario: Attached cleanup cannot be proven

- **WHEN** an attached adapter fails to confirm cancellation or quiescence
- **THEN** the lifecycle transition SHALL fail before changing bindings
- **AND** the failure SHALL be logged with bounded run, owner-Conversation, and runtime identifiers
- **AND** orchestration MUST NOT report the attached work as stopped

#### Scenario: Resume invalidates both stale runtimes

- **GIVEN** resume would move Conversation A and displace Conversation B
- **WHEN** the lifecycle prepares the binding move
- **THEN** it SHALL invalidate both runtimes and quiesce each attached tree before the atomic binding write
- **AND** durable runs from either runtime SHALL remain owned by their original Conversations and origin Surfaces

### Requirement: Disposing a Conversation runtime cancels compatibility-owned delegated work

Disposing a Conversation runtime SHALL synchronously invalidate its runner and queue identity, dispose the main `AgentRunner`, and delegate all work cleanup to `DelegatedWorkHost.invalidateRuntime(runtimeId)`. Current generic and named subagent invocations SHALL be classified as attached and therefore cancelled recursively. New durable ACP runs SHALL be detached rather than cancelled. `cancelPending` SHALL continue to cancel only queued prompt work and MUST NOT invalidate delegated work while the runtime remains current.

The legacy `cancelBySession()` cascade methods MUST NOT remain the Conversation-lifecycle seam: cleanup that swallows errors or returns after a timeout cannot satisfy the required pre-commit quiescence proof. Adapter-local best-effort cleanup MAY remain for process shutdown, but lifecycle invalidation SHALL surface an inability to prove quiescence.

#### Scenario: Runtime disposal classifies work by recorded lifetime

- **GIVEN** runtime R owns an attached subagent and has started a durable ACP run
- **WHEN** R is disposed
- **THEN** the subagent SHALL be cancelled and proven quiescent
- **AND** the ACP run SHALL continue without R's callbacks

#### Scenario: Runtime absent but attached record exists

- **WHEN** invalidation finds no cached main runner but finds attached work registered to the runtime identity
- **THEN** it SHALL still cancel and await that work
- **AND** absence of the main runner SHALL NOT make cleanup a no-op

#### Scenario: Queued prompt cancellation remains non-cascading

- **WHEN** `cancelPending` removes a queued prompt while its Conversation runtime remains valid
- **THEN** attached and durable delegated work SHALL continue unchanged

## REMOVED Requirements

### Requirement: External-agent runs follow Goblin session lifecycle

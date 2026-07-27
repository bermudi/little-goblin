# external-agents

## ADDED Requirements

### Requirement: Conversation lifetime and ACP restart continuation are independent

A new ACP external-agent run SHALL be classified in code as durable for Conversation-lifecycle purposes. It SHALL survive invalidation, rotation, rebinding, archive, and `/project` changes of its creating runtime without changing owner, origin Surface, or Execution Environment. Durable Conversation lifetime MUST NOT imply that the ACP server process survives, that the ACP session is resume-eligible, or that task execution is exactly once.

ACP clean-restart continuation SHALL continue to depend exclusively on the persisted ACP checkpoint, server fingerprint, advertised support, code-owned resume eligibility, absolute deadline, host boot id, clean-detach proof, and stopping/cleanup invariants. A durable run that cannot satisfy those requirements SHALL become interrupted or block startup exactly as ACP specifies rather than replaying its task or being rerouted.

#### Scenario: Conversation rotates while ACP keeps running

- **GIVEN** a durable ACP run is active under a live server process
- **WHEN** its owner Conversation rotates or moves
- **THEN** the run SHALL continue in its captured Execution Environment
- **AND** SHALL retain its original owner and origin Surface without retaining the stale runtime callback

#### Scenario: Durable but not resume-eligible

- **GIVEN** a durable run uses Devin or a custom server that is not code-owned resume-eligible
- **WHEN** Goblin shuts down
- **THEN** ACP's non-resumable cleanup and interruption behavior SHALL apply
- **AND** Conversation durability SHALL NOT invent restart continuation

#### Scenario: ACP checkpoint remains authoritative

- **GIVEN** a durable Claude or Codex run lacks clean-detach proof on the same host boot
- **WHEN** Goblin starts
- **THEN** startup SHALL block under the ACP hard-crash rule
- **AND** the run's durable lifetime SHALL NOT bypass that safety gate

### Requirement: ACP continuation children inherit delegated-work authority

Every child run created by `external_agent message` SHALL inherit the source run's `ownerConversationId`, code-owned lifetime, immutable Execution Environment, and `originSurfaceId`. It SHALL receive its own run id, deadline, terminal state, delivery state, and ACP lineage fields as already specified. The child MUST NOT recapture origin or filesystem authority from the caller's current Surface, binding, runtime, or CWD.

#### Scenario: Owner moved before follow-up

- **GIVEN** durable run A originated on Surface X and its owning Conversation later moved to Surface Y
- **WHEN** the owner calls `message` on eligible lineage head A from Y
- **THEN** child B SHALL retain X as `originSurfaceId` and A's immutable Execution Environment
- **AND** B's automatic completion SHALL remain deliverable only on X

#### Scenario: Equal-CWD caller cannot continue lineage

- **GIVEN** another Conversation uses the same canonical project root as run A
- **WHEN** it calls `message(A, ...)`
- **THEN** the tool SHALL return not found
- **AND** SHALL NOT disclose A's ACP lineage or create a child

## MODIFIED Requirements

### Requirement: ExternalAgentRunner owns external-agent run lifecycle

The process-wide `ExternalAgentRunner`, behind `DelegatedWorkHost`, SHALL own every external-agent run from accepted creation through terminal execution and delivery resolution. Each new run SHALL have a UUID, configured ACP server id in `backend`, `ownerConversationId`, code-owned `lifetime: "durable"`, immutable project Execution Environment, `originSurfaceId`, no attached runtime identity, timestamps, independent delivery state, and one ACP status from `starting`, `running`, `stopping`, `completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`. New ACP runs SHALL NOT use `input_required`, and no model-controlled field may select lifetime, owner, origin, or environment.

The terminal statuses SHALL remain `completed`, `failed`, `cancelled`, `timed_out`, and `interrupted` and SHALL be immutable. `stopping` SHALL continue to mean that one terminal outcome was claimed in `pendingTerminalStatus` but local child exit is not proven. Cancel, timeout, ACP completion/failure, startup failure, and cleanup races SHALL synchronously claim at most one outcome. Terminal execution state SHALL be exposed only after ordered result/event persistence and confirmed local cleanup.

For an autonomous terminal outcome, the runner SHALL commit the bounded pending-delivery reference for `originSurfaceId` before exposing terminal state. Explicit cancellation whose control response is delivered MAY set delivery to `suppressed` rather than enqueue a duplicate cancellation notice. A completion callback, status callback, turn sink, or Telegram object from the creating runtime MUST NOT be retained after the initiating tool call or runtime invalidation.

#### Scenario: Start creates durable owned ACP run

- **WHEN** `start()` receives an enabled ACP server id plus validated current-runtime ownership context
- **THEN** it SHALL return a new UUID without waiting for task completion
- **AND** persist owner Conversation, durable lifetime, origin Surface, immutable project environment, delivery state, server id, deadline, and timestamps before ACP execution

#### Scenario: Lifetime fields are code-owned

- **WHEN** a model calls `external_agent start`
- **THEN** it SHALL have no parameter for lifetime, owner Conversation, runtime identity, Surface, CWD, or Execution Environment
- **AND** the runner SHALL derive those values from the validated current runtime context

#### Scenario: End turn separates execution and delivery

- **WHEN** ACP returns `end_turn` and cleanup confirms local exit
- **THEN** the run SHALL become execution-terminal `completed`
- **AND** its delivery SHALL remain `pending` until accepted on the origin Surface or explicitly resolved

#### Scenario: Cleanup cannot confirm exit

- **WHEN** a run claims an outcome but cleanup grace expires before local children exit
- **THEN** it SHALL remain `stopping`, retain its pending outcome and concurrency slot, and block starts as already specified
- **AND** it SHALL NOT enqueue or expose a false terminal completion

#### Scenario: Stale runtime callback is absent

- **WHEN** a durable run emits output after its creating runtime was invalidated
- **THEN** output SHALL be persisted through the runner's bounded event path
- **AND** no callback, sink, or Telegram object from the old runtime SHALL be invoked

### Requirement: external_agent tool exposes task-level actions

The main Goblin agent SHALL receive one `external_agent` tool when at least one configured ACP server is enabled. Its action SHALL remain one of `start`, `status`, `message`, `cancel`, or `list`:

- `start` SHALL accept only configured agent id and task; it SHALL derive `ownerConversationId`, `originSurfaceId`, and immutable project Execution Environment from the calling current runtime and start a code-owned durable run.
- `status` SHALL accept a run id controlled by the calling Conversation and return bounded status, agent id, timestamps, output, pending cleanup outcome, delivery state, and final result when present.
- `message` SHALL accept an owner-controlled completed lineage head and follow-up text, preserve all existing ACP eligibility/lineage guards, and create an immutable child that inherits delegated-work authority.
- `cancel` SHALL accept an owner-controlled run id and invoke destructive explicit cancellation.
- `list` SHALL return bounded metadata only for runs whose `ownerConversationId` equals the calling Conversation.

The tool MUST NOT accept a cwd, executable, arguments, environment, permission profile, owner Conversation, lifetime, runtime identity, Surface, Execution Environment, timeout, ACP session id, mode/config option, terminal id, or terminal action. Status, message, cancel, and list authorization SHALL use `ownerConversationId`, not current Surface or environment. A mismatched owner SHALL receive `External agent run not found` without existence disclosure. A moved owning Conversation MAY explicitly use these operations without changing automatic delivery routing.

#### Scenario: Start captures current runtime authority

- **WHEN** Conversation C on Surface X starts an enabled ACP agent from project environment P
- **THEN** the run SHALL record C, X, P, and durable lifetime from trusted runtime context
- **AND** return its id before task completion

#### Scenario: Start without project environment

- **WHEN** `start` is called from a personal Conversation
- **THEN** the tool SHALL return the existing clear project-required error
- **AND** no run metadata, pending delivery, or process SHALL be created

#### Scenario: Cross-Conversation access is rejected

- **WHEN** Conversation B calls `status`, `message`, or `cancel` with a run id owned by Conversation A
- **THEN** the tool SHALL return `External agent run not found`
- **AND** MUST NOT disclose that the run exists

#### Scenario: Owning Conversation moved Surfaces

- **GIVEN** Conversation A created a run on Surface X and later moved to Y
- **WHEN** A requests status from Y
- **THEN** it SHALL receive the bounded status
- **AND** the request SHALL NOT retarget pending completion from X to Y

#### Scenario: Message preserves ACP lineage rules

- **WHEN** `message` targets an owner-controlled run completed by `end_turn` with compatible resume capability and no existing child
- **THEN** it SHALL create a distinct child under the same internal ACP session and inherited delegated-work authority
- **AND** preserve source immutability, lineage-head exclusivity, fingerprint checks, and a fresh child deadline

#### Scenario: Tool remains main-agent only

- **WHEN** a pi subagent toolset is assembled
- **THEN** it MUST NOT include `external_agent`

### Requirement: external run records are bounded and persisted

Each run SHALL continue to persist bounded ACP artifacts under `$GOBLIN_HOME/scratch/external-agents/<runId>/` through validated path helpers: atomic `meta.json`, complete ordered JSON lines in `events.jsonl`, and atomic bounded `result.txt`. Existing limits SHALL remain: 32,000 characters per normalized output event, 2 MiB retained event content per run, 128,000 characters for final result, 16,000 characters for status recent output, and 20 newest owned runs per list response. Task text MUST NOT be intentionally persisted or returned except for provider echoes under the existing rule.

New canonical metadata SHALL replace `ownerSessionId` with `ownerConversationId` and SHALL add validated `lifetime`, optional attached runtime identity, immutable Execution Environment, canonical `originSurfaceId`, and delivery state. It SHALL preserve ACP server/checkpoint, deadline, recovery, lineage, boot-id, pending-terminal, truncation, status, and timestamp fields from the prerequisite contract. New ACP records SHALL have `lifetime: "durable"` and no attached runtime identity.

The delegated-work store SHALL atomically maintain bounded pending-delivery references separately from execution artifacts. Each reference SHALL include run id, owner Conversation, exact origin Surface, terminal status, completion time, and bounded injectable material; it SHALL NOT duplicate unbounded event history or task text. A pending reference SHALL pin the bounded result needed for delivery so ordinary terminal-retention cleanup cannot make the claim unreadable. Claim, acknowledge, release, suppression, and startup recovery SHALL be atomic and idempotent.

Startup migration SHALL compute and validate all ownership rewrites before its first mutation. It SHALL map a legacy `ownerSessionId` to one unambiguous `ownerConversationId`, derive one authoritative origin Surface, canonicalize the recorded project directory to a project Execution Environment, and require equality with the owner's immutable environment. Legacy non-terminal records SHALL become attached and receive a compatibility runtime ownership epoch; if no live creating runtime can be proven, startup SHALL quiesce them through attached invalidation rather than adopt them as durable. Legacy terminal records SHALL become delivered or suppressed and MUST NOT create pending delivery. Ambiguous owner/origin or environment mismatch SHALL fail before ownership writes. Existing bounded output/result, statuses, timestamps, and ACP resume checkpoints SHALL be retained without task replay or notification backfill.

#### Scenario: New run record contains delegated authority

- **WHEN** a new ACP run is accepted
- **THEN** atomic metadata SHALL contain `ownerConversationId`, durable lifetime, project Execution Environment, origin Surface, and delivery state
- **AND** SHALL NOT contain legacy owner-session authority or a mutable project directory as the authority source

#### Scenario: Pending completion pins bounded delivery material

- **GIVEN** a terminal run remains pending for an unavailable origin Surface
- **WHEN** ordinary terminal artifact cleanup runs
- **THEN** the bounded completion required for claim SHALL remain readable
- **AND** event history beyond existing retention and bounds need not be retained for delivery

#### Scenario: Legacy active record becomes attached

- **GIVEN** a valid legacy non-terminal ACP record belongs unambiguously to Conversation C, Surface X, and project environment P
- **WHEN** migration runs
- **THEN** it SHALL retain ACP checkpoint and bounded artifacts
- **AND** write attached lifetime and a compatibility runtime ownership epoch rather than upgrade it to durable

#### Scenario: Legacy terminal records do not flood delivery

- **GIVEN** one or more legacy terminal records contain historical results
- **WHEN** migration succeeds
- **THEN** each SHALL be marked delivered or suppressed
- **AND** no pending-completion record or Telegram notification SHALL be created for historical output

#### Scenario: Migration authority is ambiguous

- **WHEN** a legacy record has no unique owner Conversation or origin Surface
- **THEN** migration SHALL fail before changing any delegated-work ownership record
- **AND** SHALL report bounded record and candidate identifiers for operator repair

#### Scenario: Migration environment mismatches

- **GIVEN** a legacy record's canonical project directory differs from its owner's immutable Execution Environment
- **WHEN** migration validates records
- **THEN** startup SHALL fail before mutation
- **AND** SHALL NOT relabel the run, discard its checkpoints, or choose an equal-CWD Surface

#### Scenario: Migration rerun is idempotent

- **WHEN** startup reruns after a complete or interrupted ownership migration
- **THEN** canonical records and pending states SHALL converge without duplicate claims, notifications, or run directories

### Requirement: cancellation is idempotent and owner-scoped

`ExternalAgentRunner.cancel(runId, ownerConversationId)` SHALL authorize by exact owner Conversation, synchronously claim pending `cancelled`, enter `stopping`, and prevent later state changes before awaiting the existing destructive ACP cleanup. Confirmed child exit SHALL permit terminal `cancelled`, slot release, and delivery suppression; cleanup expiry SHALL leave `stopping` and block starts. Repeated cancel of terminal or stopping work SHALL not duplicate cleanup. An unauthorized owner SHALL receive not found and no run disclosure.

`cancelByConversation(ownerConversationId)` SHALL attempt every non-terminal attached and durable external run owned by that Conversation even if one cleanup fails, and SHALL return enough failure information for explicit cancel orchestration to report unproven quiescence. Runtime invalidation SHALL instead cancel only attached runs for the exact runtime ownership epoch and detach durable runs. Process-shutdown detachment SHALL remain distinct from both operations and SHALL preserve only ACP runs satisfying clean-restart requirements.

#### Scenario: Owner explicitly cancels durable run

- **WHEN** the owning Conversation cancels a durable ACP run
- **THEN** pending `cancelled` SHALL win before cleanup is awaited
- **AND** prompt, ACP session when appropriate, terminals, and server process SHALL receive destructive cleanup
- **AND** successful control response SHALL suppress duplicate completion delivery

#### Scenario: Cancel all for Conversation

- **WHEN** `cancelByConversation(C)` is called and C owns attached legacy and durable new runs
- **THEN** every non-terminal run owned by C SHALL receive cancellation
- **AND** runs owned by other Conversations SHALL remain unchanged

#### Scenario: Runtime invalidation does not cancel durable run

- **WHEN** `invalidateRuntime(R)` reaches a durable run created from R
- **THEN** it SHALL remove stale runtime observation only
- **AND** SHALL NOT send ACP cancellation or change terminal state

#### Scenario: Unauthorized cancel is hidden

- **WHEN** Conversation B attempts to cancel Conversation A's run
- **THEN** cancellation SHALL return not found
- **AND** A's run and delivery state SHALL remain unchanged

#### Scenario: Timeout races explicit cancel

- **WHEN** timeout and owner cancellation race
- **THEN** exactly one pending terminal outcome SHALL win
- **AND** ACP and process cleanup SHALL execute at most once

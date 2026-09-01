---
role: contract
owns: delegated-work-delivery
---

# Delegated Work: Durable Lifetime And Completion Delivery

## Purpose

Implements the durable half of decision 0036 on top of the decision-0045
record store. Attached-lifetime semantics are already CURRENT; this spec
owns only the durable addition.

Out of scope: external-agent durable runs (decision 0044 ACP cycle),
inner-life consent layering (decision 0035 — this is decision-0036 reactive
completion contact, not proactive contact), graceful shutdown drain of
durable runs (process death is honestly recorded as interruption), and any
status-listing command surface.

## Requirements

### Requirement: Durable Spawn Capture And Invalidation Immunity

WHEN a delegated run is spawned with durable lifetime, THE SYSTEM SHALL
capture a record invocation with `lifetime: "durable"` and the full
decision-0036 capture set (owner Conversation, runtime identity at spawn
time, ownership epoch, origin Surface, immutable Execution Environment),
and runtime invalidation or Conversation rotation SHALL NOT cancel, fence,
or retarget it.

#### Scenario: Background run survives rotation

- **WHEN** a background durable run spawned in chat A completes after the
  owner Conversation is rotated with `/new`
- **THEN** chat A receives the result, the new conversation is not the
  owner, and the record shows one durable invocation, completed, delivered

#### Scenario: Runtime invalidation leaves durable registrations alone

- **WHEN** the spawning runtime is invalidated while a durable run it
  spawned is still active
- **THEN** the run is not cancelled, fenced, or retargeted and continues
  toward terminal completion in process

### Requirement: Background Spawn Returns Without Blocking

WHEN the spawn entry is used in background mode, THE SYSTEM SHALL return
the run id to the calling turn immediately without blocking, and the
blocking-call timeout SHALL NOT apply to the run.

#### Scenario: Background spawn returns immediately

- **WHEN** the spawn entry is used in background mode
- **THEN** the run id returns to the calling turn immediately without
  blocking, and the blocking-call timeout does not apply to the run

### Requirement: Completion Wake Delivery To The Bound Origin Surface

WHEN a durable invocation completes AND its origin Surface is currently
bound and authorized, THE SYSTEM SHALL deliver the result to that exact
SurfaceId through the surface-bound system-turn rail without creating a
Conversation, and SHALL mark the invocation delivered only after the send
is accepted. Failed executions SHALL be suppressed, never auto-delivered.

#### Scenario: Completion wakes the bound origin Surface

- **WHEN** a durable invocation completes while its origin Surface is
  currently bound and authorized
- **THEN** the result is delivered to that exact SurfaceId through the
  surface-bound system-turn rail without creating a Conversation, and the
  invocation is marked delivered only after the send is accepted

#### Scenario: Failed executions are suppressed

- **WHEN** a durable execution fails
- **THEN** the result is suppressed and never auto-delivered

### Requirement: Pending Claim On The Exact Origin Surface

WHEN a durable completion cannot be delivered (origin Surface unbound, send
failure, or process restart with delivery still pending), THE SYSTEM SHALL
retain it pending for that exact SurfaceId. WHEN the next authorized
ordinary interaction occurs on that exact Surface, THE SYSTEM SHALL claim
the pending completions oldest-first, bounded per claim, and deliver them.
A guest Surface SHALL NOT claim without an authorized guest summon. No
fallback routing SHALL occur.

#### Scenario: Pending claim

- **WHEN** the origin Surface is unbound at completion and a user message
  later arrives on that exact Surface
- **THEN** the completion stays pending until that message, the retained
  result is delivered before or with the normal turn, and the delivery
  state becomes delivered

#### Scenario: Guest surfaces cannot claim without summon

- **WHEN** the next interaction on the origin Surface comes from a guest
  Surface without an authorized guest summon
- **THEN** no pending completions are claimed and no fallback routing
  occurs

#### Scenario: Startup re-arm

- **WHEN** the process starts while durable completions are retained pending
- **THEN** completions whose origin Surface is currently bound are
  re-delivered oldest-first under the per-claim cap without waiting for
  interaction, unbound ones stay pending for the next claim, and guest
  Surfaces are not re-armed without an authorized summon

### Requirement: Startup Reconciliation, Revival, And Owner Cancellation

WHEN the process starts AND a durable invocation is non-terminal, startup
reconciliation SHALL mark it interrupted (the run died with the process);
explicit revival SHALL append a new invocation continuing the persisted
session state in place. Explicit cancellation from the owning Conversation
SHALL remain destructive for durable runs.

#### Scenario: Restart truth

- **WHEN** the process dies mid-run and later restarts
- **THEN** the record shows the invocation interrupted after restart,
  revival continues the session as a new invocation, and nothing silently
  resumes

#### Scenario: Owner cancellation

- **WHEN** the owning Conversation cancels the run
- **THEN** the record closes terminal `cancelled`, delivery is suppressed,
  and execution is fenced

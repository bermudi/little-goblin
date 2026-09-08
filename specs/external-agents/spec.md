---
role: contract
owns: external-agent-acp-execution
---

# External Agents: Capability-Scoped ACP Execution

## Purpose

Implements decisions 0040, 0041, 0044, and 0045 for external agents: Claude
Code and Devin execute through ACP behind a dedicated external-agent execution
host, fully trusted as same-user delegates, with model-selected launch input
and records in the one host-owned delegated-run store. This spec owns the
external-agent addition; `specs/delegated-work/spec.md` owns the delivery
machinery these records ride.

Out of scope: Codex (transport unclassified under decision 0044; it leaves the
enabled-backend surface until separately classified behind this host),
client-hosted ACP filesystem/terminal/virtual-terminal capability, active-turn
resume after server or process loss (honestly recorded as interruption; replay
would need its own accepted decision), PTY fallback, migration off legacy
`scratch/external-agents/` (abandoned in place, operator deletes manually),
and external-agent metrics.

## Requirements

### Requirement: Qualified Backends Behind A Capability-Scoped Host

WHEN Goblin executes Claude Code or Devin work, THE SYSTEM SHALL connect
through one external-agent execution host — separate from the Pi execution
host — that spawns the exact-version-pinned
`@agentclientprotocol/claude-agent-acp` bridge for Claude and the installed
native `devin acp` server (configured model default `glm-5.2`) for Devin, and
SHALL advertise no client filesystem or terminal capability and implement no
such handlers. Exact-version pinning and per-backend capability expectations
(Claude: `session/resume` and `session/close`; Devin: `session/load` and
`session/delete`, no `session/resume`) SHALL be verified by compatibility
tests; changing the pin requires re-running them.

#### Scenario: No client-hosted capability

- **WHEN** the host initializes any ACP connection
- **THEN** the client advertises no filesystem or terminal capability, server
  requests for those methods fail closed, and no Goblin-side handler exists

#### Scenario: Pin is the contract

- **WHEN** tests run against the resolved bridge package
- **THEN** its version equals the pinned version and the per-backend
  capability expectations hold

### Requirement: Per-Connection Permission Profile

WHEN any new, resumed, or loaded connection is made, THE SYSTEM SHALL
explicitly apply the structured permission profile selected for the delegated
run — including the unattended dangerous profile required by decision 0041 —
and SHALL NOT infer the profile from prior connection state. Permission
responses follow the selected profile; profiles are operational affordances,
not a security boundary below the same-user OS floor.

#### Scenario: Profile applied on every connection

- **WHEN** a run connects, resumes, or loads
- **THEN** the selected profile is applied to that connection and permission
  requests are answered according to it

### Requirement: Model-Selected Launch Input, Captured Not Confined

WHEN the model starts an external-agent run, THE SYSTEM SHALL accept explicit
working directory, permission profile, and bounded invocation parameters as
structured launch input, validate them structurally, and capture them with
the delegated-run record so the actual execution context is observable.
Validation SHALL NOT be presented as confinement (decision 0041's same-user
OS floor), and child environments SHALL receive only the decision-0041
allowlist — never ambient Goblin secrets.

#### Scenario: Launch outside the project environment

- **WHEN** the model selects a working directory outside the Conversation's
  Execution Environment with the unattended dangerous profile
- **THEN** the run executes there, the record captures the selection, and no
  confinement claim is made or enforced

### Requirement: Durable Records And Honest Interruption

WHEN an external-agent run starts, THE SYSTEM SHALL create a delegated-run
record in the one host-owned store (`state/delegated-work/runs/`) with an
external kind carrying backend identity, a durable-lifetime invocation with
the full decision-0036 capture set, and persisted provider session identity
in the run directory. WHEN the process loses a non-terminal run, startup
reconciliation SHALL mark the invocation interrupted; nothing SHALL
auto-resume an active turn. Completed invocations SHALL ride the existing
completion-wake and exact-Surface pending-claim delivery unchanged.

The record kind is `external-agent`. Its `external` state contains `backend`
(`claude` or `devin`) and `providerSessionId`, initially null until the execution
coordinator captures the ACP session identity through `DelegatedWorkHost`.
That state lives in the same atomically replaced `record.json`; capture cannot
replace a different provider identity or mutate terminal context. Completion
requires captured provider identity. External records cannot be revived through
the Pi subagent path.

#### Scenario: Canonical external identity

- **WHEN** the coordinator creates an external record and captures its ACP session
- **THEN** the one host-owned record contains the qualified backend, provider
  session identity, and full durable ownership capture; malformed identities
  and attached external invocations are rejected before persistence

#### Scenario: Restart truth

- **WHEN** Goblin dies mid-run and restarts
- **THEN** the external invocation is interrupted after restart and no
  continuation prompt is sent automatically

### Requirement: Completed-Context Follow-Up And Retirement

WHEN follow-up work targets a completed run's provider context, THE SYSTEM
SHALL append a new invocation on the same record and continue through
Claude `session/resume` or Devin `session/load` (capability-gated), with the
selected profile re-applied. WHEN provider context is intentionally retired,
THE SYSTEM SHALL use Claude `session/close` or Devin `session/delete` —
distinct from local process cleanup, which is bounded and escalates to
process termination when transport closure does not exit.

#### Scenario: Follow-up continues completed context

- **WHEN** follow-up is requested on a run whose last invocation completed
- **THEN** a new invocation continues the persisted provider session and the
  prior invocation remains terminally closed

#### Scenario: Retirement is not process exit

- **WHEN** a server process exits or is killed
- **THEN** provider context is not retired by that fact alone, and a
  transport-ignoring server is still terminated after a bounded escalation

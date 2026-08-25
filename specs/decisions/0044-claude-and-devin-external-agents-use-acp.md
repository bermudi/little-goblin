---
id: 0044
date: 2026-08-04
status: accepted
spine: false
builds_on: [0036, 0040, 0041]
---

# 0044: Claude and Devin External Agents Use Capability-Scoped ACP

## Status

accepted

## Context

Goblin's legacy external-agent runner uses provider-native event streams for Claude and Codex, ACP only for new Devin sessions, and a destructive PTY fallback when structured execution needs interaction. Decision 0040 assigned provider and process mechanics to a distinct external-agent execution host but deliberately left its protocol open. The frozen ACP proposal assumed that ACP clients should host filesystem and terminal operations and that a fresh server could recover an active task without Goblin persisting the task text.

Human-present executable scouting tested Claude Code 2.1.211 through `@agentclientprotocol/claude-agent-acp` 0.64.2 and Devin 3000.3.27 through its native ACP server with model `glm-5.2`. Both created sessions, completed prompts, used their own coding tools while the client advertised no filesystem or terminal capability, and preserved context when continuing a completed turn through a fresh server process. Claude advertised and implemented `session/resume`, `session/close`, and graceful transport shutdown. Devin did not implement `session/resume`; it preserved completed context through `session/load`, supported `session/delete`, and required bounded process termination after some completed turns.

The same experiment disconnected each backend after response streaming began but before the prompt completed. A fresh Claude resume and Devin load both lost the interrupted user turn. An unpersisted "continue" prompt therefore cannot recover active work. Mode state also was not reliable across every fresh connection, so launch policy cannot be inferred from prior session state.

## Decision

Claude Code and Devin external-agent execution SHALL use ACP behind the external-agent execution host established by decision 0040. Claude SHALL run through an exact-version pinned `@agentclientprotocol/claude-agent-acp` bridge; the initially qualified version is 0.64.2. Changing the bridge version requires rerunning protocol compatibility tests. Devin SHALL use its installed native `devin acp` server, with `--model glm-5.2` as the configured deployment default.

For these backends, Goblin SHALL advertise neither ACP client filesystem nor terminal capability and SHALL NOT implement virtual terminal or filesystem handlers merely because ACP offers them. Claude and Devin own their coding-tool execution inside their provider processes. A future backend that actually requires client-hosted capabilities needs separate evidence and an explicit capability-specific design; it SHALL NOT enlarge this boundary by default.

Every new or continued connection SHALL explicitly apply the structured permission profile selected for the delegated run. Supported launch input includes an unattended dangerous profile as required by decision 0041. Goblin SHALL NOT infer the active profile from a prior connection. Backend acknowledgements and exact-version compatibility tests are the application contract; mode controls remain operational affordances, not a security boundary.

Completed-turn continuation is backend-specific: Claude uses `session/resume`; Devin uses `session/load`. The delegated-work subsystem may offer follow-up work against that completed provider context, but decision 0036 remains authoritative for delegated-run identity, ownership, lifetime, and delivery.

An active prompt SHALL NOT be resumed automatically after its ACP server is lost or Goblin restarts. The run becomes terminally interrupted after bounded cleanup or reconciliation. Goblin SHALL NOT claim process-restart durability by sending a generic continuation prompt, because the provider session does not retain the interrupted user turn. Persisting task text and deliberately replaying it would create duplicate-side-effect and sensitive-prompt retention policy; that requires a separate accepted decision before implementation.

The execution host SHALL distinguish ACP session retirement from local process cleanup. Claude may use `session/close`; Devin may use `session/delete` when provider context is intentionally retired. Closing or killing a local server process does not by itself retire completed provider context. Local shutdown is bounded and escalates to process termination when transport closure does not exit.

This ruling does not classify Codex transport. Existing Codex behavior is legacy input, not permission to contaminate the Claude/Devin ACP host with another lowest-common-denominator protocol.

## Consequences

The target external-agent host has one protocol for the two qualified backends, but its lifecycle remains capability-driven rather than pretending `resume`, `load`, `close`, and process exit are equivalent. The implementation can delete provider parsers and PTY fallback from Claude and Devin paths without building an unnecessary virtual terminal service.

Durable delegated work may survive Conversation rotation according to decision 0036, but an active Claude or Devin turn does not survive process loss. Deployment shutdown and startup reconciliation must report that interruption honestly. Completed provider context can still support explicit follow-up work through the owning Conversation.

Exact bridge pinning and executable compatibility tests become part of upgrades. Devin cleanup needs bounded escalation. Permission modes must be reapplied after every new, resume, or load operation. Codex remains an explicit unresolved backend rather than silently inheriting claims proved only for Claude and Devin.

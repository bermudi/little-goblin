---
id: 0040
date: 2026-07-28
status: accepted
spine: false
builds_on: [0036]
---

# 0040: Pi and External-Agent Execution Use Separate Hosts

## Status

accepted

## Context

Goblin delegates work through two different execution substrates. Pi subagents construct `AgentSession` instances with Goblin memory, prompt, skill, and recursion semantics. External agents invoke separately installed provider processes and must handle provider protocols, process I/O, and backend-specific lifecycle behavior.

The legacy implementation gives these substrates sibling runners but makes orchestration callers coordinate both lifecycles. Combining them into one lowest-common-denominator runner would leak pi session concepts into provider adapters or provider process mechanics into pi construction. Keeping two independent lifecycle authorities would instead preserve the caller choreography that decision 0036 assigns to the delegated-work subsystem.

## Decision

Pi subagent construction and external-provider execution SHALL remain separate deep modules. A pi execution host SHALL own pi session construction and pi-specific runtime mechanics. An external-agent execution host SHALL own provider and process protocol mechanics.

Neither execution host nor its callers SHALL independently own delegated-run authority, cross-run lifetime, cancellation policy, or completion delivery. Those concerns belong to the delegated-work subsystem established by decision 0036. The delegated-work subsystem coordinates the execution hosts through narrow lifecycle interfaces rather than merging their substrates.

This ruling does not choose ACP, provider-native protocols, or PTY transport. It does not classify a run as attached or durable, choose canonical storage, or promise process-restart continuation.

## Consequences

Pi behavior can evolve without importing external CLI protocol concerns, and external adapters can change protocol without reconstructing Goblin memory or pi sessions. Shared ownership, delivery, and cancellation invariants have one authority instead of being repeated in dispatchers and shutdown callers.

The current `SubagentRunner` and `ExternalAgentRunner` are implementation inputs, not the target common lifecycle boundary. Future delegated-work implementation must extract caller choreography behind the delegated-work subsystem while preserving distinct execution hosts.

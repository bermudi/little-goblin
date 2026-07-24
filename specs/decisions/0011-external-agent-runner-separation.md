# External Agent Runner Separation

## Status

proposed

## Context

Goblin already has `SubagentRunner` for pi `AgentSession` construction, memory scope, recursive spawning, and pi persistence. The external-agent-runner change adds a second runner for Codex, Claude, Devin, and an internal `agent-pty` fallback. Both runners are process-wide and session-aware, but they serve different substrates: pi sessions versus OS processes and external CLI protocols.

Generalizing the two runners into one abstraction would force either pi-specific session/memory concepts into the external process path or external CLI protocols into the pi path. The surface overlap is only lifecycle vocabulary (`start`, `cancel`, `dispose`), which is not enough to justify a shared lowest-common-denominator interface.

## Decision

`ExternalAgentRunner` SHALL be a sibling module to `SubagentRunner`, not a replacement for it. It SHALL own its own run types, store, adapters, process host, and cancellation. It SHALL NOT import `AgentSession`, `SubagentRunner`, or pi-specific tool definitions.

`SubagentRunner` SHALL continue to own pi session construction, named-agent definitions, memory scope, recursive spawning, and pi persistence. Orchestration code SHALL explicitly invoke both runners during session disposal and process shutdown. Session disposal uses destructive `ExternalAgentRunner.cancelBySession`; proposed decision 0030 amends process shutdown to use its detach-aware `shutdown()` lifecycle rather than unconditional cancellation.

## Consequences

- Easier: external CLI protocol details are isolated in `src/external-agents/`, so pi behavior does not need to understand JSONL, ACP, or PTY RPC.
- Easier: `ExternalAgentRunner` can be tested with deterministic fake adapters and fake processes without bringing up pi.
- Harder: orchestration must call both runner lifecycle seams explicitly.
- Must change: `TurnDispatcher.disposeRunner` and `interruptAndCascade` invoke destructive `ExternalAgentRunner.cancelBySession`; shutdown wiring in `src/index.ts` invokes detach-aware `ExternalAgentRunner.shutdown()` under proposed decision 0030.

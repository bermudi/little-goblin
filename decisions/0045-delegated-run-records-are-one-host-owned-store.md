---
nospec: true
id: 0045
date: 2026-08-04
status: accepted
spine: false
builds_on: [0036, 0038, 0040]
---

# 0045: Delegated-Run Records Are One Host-Owned Store

## Context

Delegated-run records originate in `SubagentRunner` and `execution.ts` and persist as `meta.json` across two trees: `scratch/subagents/<id>/` for generic subagents and `workspace/agents/<name>/instances/<id>/` for named-agent instances. Every id lookup scans both trees and refuses ambiguity; machine-managed named instances share a workspace directory with user-authored definitions; and `scratch/` makes durable records formally disposable. The architecture layout sketch proposed three replacement trees (`state/delegated-work/` as a pending-completion index, `state/subagents/`, `state/external-agents/`), but it predates decision 0036, which gives every delegated run one uniform ownership contract regardless of kind.

The in-memory `DelegatedWorkHost` slice established attached-work fence, invalidation, and cancellation policy without persistence. Meanwhile revival patches the same record back to `running` — even across process restarts — so a record can claim a run is alive after its owning runtime and process have died, contradicting decision 0036's attached-lifetime semantics.

The decision owner ruled on the two open questions: delegated work has one record store, not per-kind trees; and revival preserves the same agent with the same session rather than forfeiting context at process death.

## Decision

All delegated-run records SHALL live in one host-owned store at `state/delegated-work/runs/<id>/`: a validated `record.json` plus that run's kind-specific execution state (pi session files for pi-backed kinds). This supersedes the three-tree layout sketch. Pending completions SHALL be a query over records' delivery state, not a separate index directory. `DelegatedWorkHost` SHALL own record creation, lifecycle transitions, listing, and revival intent; execution coordinators go through it and never write record files directly.

A record SHALL be a stable delegated-work identity plus an append-only invocation log. The identity carries the run id, kind (`generic-subagent`, `named-subagent`, later external kinds), the optional agent name, and creation time. Each invocation is one run in decision 0036's sense and carries that decision's required captures: owner Conversation, runtime identity, ownership epoch, lifetime, origin Surface, Execution Environment, status, terminal outcome, and delivery state. Invocation entries are appended and terminally closed, never rewritten as history.

Revival SHALL append a new invocation that continues the persisted session state in place (pi history in the same run directory). A prior invocation terminated by process or runtime loss SHALL remain terminally interrupted; a record SHALL NOT be patched back to `running`. Attached invocations non-terminal at startup SHALL be marked interrupted by reconciliation, because their runtime died with the process.

Storage cutover SHALL be offline migration step 5 (filesystem state version 5) under decision 0038. Step 5 is a **layout break, not a data transformation**: it creates `state/delegated-work/runs/` when absent and advances the version gate so new code never polls a pre-break home. No legacy `meta.json` is read, wrapped, or moved. Legacy `scratch/subagents/` and `workspace/agents/*/instances/` trees are abandoned in place; the operator deletes them manually after verifying the new tree. Named-agent definitions remain user-authored under `workspace/agents/<name>/`. `scratch/external-agents/` is likewise abandoned in place when the ACP cycle lands under decision 0044 — no migration and no backwards compatibility, matching this cutover.

This ruling does not settle durable-lifetime runs, the pending-completion claim/ack/release protocol, external-agent record payloads, or automatic delivery mechanics.

## Consequences

One persistence boundary replaces the two-tree scan: listing, revival lookup, and startup reconciliation become single-tree operations, and the cross-tree ambiguity failure mode disappears for new records. Delivery state can no longer disagree with a separate index because there is none. Revival keeps stable run ids and full session continuity across restarts while records tell the truth about interruption, and the invocation log gives future ACP continuation its shape for free — a follow-up run is a new invocation resuming persisted provider session state.

Append-only invocation entries still mutate the record file; the validated atomic-rewrite discipline from `meta.ts` moves into the store rather than being relaxed. Attached named agents are now honestly interrupted by process death: continuation requires explicit revival, matching current user-facing behavior, but nothing silently resumes. Startup reconciliation marks attached non-terminal invocations in the new store interrupted. After step 5, Goblin neither reads nor writes the abandoned subagent trees; `scratch/external-agents` remains a live legacy tree until the ACP cycle, so "no scratch" is not yet complete. The deployment must run `bun run migrate` before the new code will poll.

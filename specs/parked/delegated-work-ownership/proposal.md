# delegated-work-ownership

## Motivation

Goblin currently keys subagent and external-agent ownership through the overloaded session/runtime model. Runtime disposal can therefore cascade into work without distinguishing whether it was meant to be attached, while durable work can outlive its original context without a stable control owner or delivery destination. Rebinding or rotating history also creates a tempting but unsafe fallback: deliver a result to whichever Surface now shares the Conversation or project CWD.

Decision 0036 separates execution lifetime, control authority, filesystem authority, and completion routing. This change applies that model consistently to current generic/named subagents and ACP external-agent runs after Conversation lifecycle is explicit.

## Scope

This change depends on `immutable-project-environments`, `conversation-lifecycle`, and `acp-external-agents`. It affects three capabilities: orchestration, subagents, and external agents.

### Ownership policy

- Make the delegated-work subsystem the owner of every run record and execution lifecycle. Every invocation records `ownerConversationId`, immutable Execution Environment, and `originSurfaceId`; attached work additionally records the creating runtime identity.
- Use `ownerConversationId` as the sole authority for explicit status, continuation, run-specific cancellation, and conversation-wide cancellation. Origin Surface, current binding, and canonical CWD equality do not grant control.
- Keep lifetime classification code-owned in this change. Current synchronous generic and named subagent invocations are **attached**. Every newly started ACP external-agent run is **durable**. Existing persisted external-agent records migrate as **attached** to preserve their previous destructive Conversation-lifecycle behavior. No model-facing lifetime switch is added.

### Orchestration

- Introduce one `DelegatedWorkHost` runtime-invalidation operation. It fences the invalid runtime, cancels its full attached work tree, detaches durable work from stale runtime callbacks without cancelling it, and returns only when attached quiescence is proven. A lifecycle transition fails before binding commit when quiescence cannot be proven.
- Keep explicit cancellation separate from runtime invalidation. `cancelByConversation(ownerConversationId)` is destructive for both attached and durable work and remains available to explicit user interrupt/cancel flows.
- Let durable runs survive `/new`, `/resume`, `/archive`, `/project`, rebinding, and runtime recreation without changing owner, origin Surface, or environment. They never follow the replacement runtime or its project context.
- Keep execution outcome and completion-delivery state separate. Terminal completion creates a bounded pending-delivery reference for the captured origin Surface; no stale turn callback or Telegram sink is retained.
- Let the next authorized ordinary interaction on the exact origin Surface claim a bounded completion batch. The pending-delivery seam never creates a Conversation: ordinary-message lifecycle resolution may do so under its existing authority, after which dispatch can accept the claim. Mark delivery only after current-runtime dispatch accepts the injected completion; release the claim on rejection or failure before acceptance. A missing matching interaction leaves it pending.
- A guest completion may be claimed only by a later authorized guest summon from the same guest `SurfaceId`. An unavailable or unbound origin suspends contact; there is no background push, fallback Surface, or equal-CWD reroute.

### Subagents

- Keep current generic and named subagent invocations attached because their blocking tool contract returns the result to the caller and has no detached-result channel.
- Capture the owner Conversation, creating runtime identity, origin Surface, immutable environment, and active memory context at each top-level spawn. Recursive children inherit that root ownership epoch and authority without re-resolving current bindings or project settings.
- Runtime invalidation cancels the complete attached tree and prevents late child creation or result delivery through the invalid caller. Preserve result-to-caller behavior, explicit owner-scoped cancellation, recursion depth, named persona memory, and existing generic/named skill policy.
- Revival reuses persisted pi history but starts a new attached invocation under the reviving runtime after owner authorization. It captures that runtime's identity and context and does not resurrect the old ownership epoch.

### External agents

- Replace legacy owner-session authority with `ownerConversationId`; add code-owned `lifetime`, `originSurfaceId`, captured Execution Environment, optional attached runtime identity, and independent delivery state to ACP run records and adapters.
- Make new ACP starts durable across Conversation lifecycle transitions while preserving ACP's separate clean-restart continuation contract. Durable at the Conversation layer does not imply process survival; ACP resume eligibility, deadlines, stopping/cleanup proof, and restart blocking remain authoritative.
- Keep timeout, run-specific explicit cancel, owner-wide explicit cancel, process cleanup, and ACP session cleanup destructive. Preserve owner isolation and not-found behavior without disclosing another Conversation's run.
- Make ACP `message` continuation children inherit the source run's owner, lifetime, origin Surface, and immutable environment. A continuation does not recapture authority from the caller's current Surface or CWD.

### Migration

- Migrate legacy active or otherwise non-terminal external-agent records as attached. If no creating runtime can be proven live at startup, reconcile them through attached-work invalidation rather than silently adopting them as durable.
- Mark legacy terminal records delivered or suppressed during migration. Do not create pending-delivery entries for historical completions and do not emit a notification backfill flood.
- Validate and compute the complete migration before mutation. A missing or ambiguous owner Conversation, ambiguous origin Surface, or project-directory/environment mismatch fails startup before ownership writes.
- Preserve existing bounded output, result artifacts, terminal state, timestamps, and ACP resume/checkpoint fields. Migration changes ownership and delivery metadata; it does not replay tasks, invent ACP resumability, or discard audit evidence.
- Legacy persisted subagent history remains revival-readable. Revival supplies a fresh attached ownership epoch; historical terminal metadata is not queued for delivery.

## Non-Goals

- **Surface recovery:** choosing a replacement for a deleted or permanently unreachable Telegram topic is separate policy. This change never guesses another destination.
- **Durable subagents:** current subagent tools block for a caller result. A detached subagent result channel is future work, not a lifetime flag added to the model schema.
- **Model-selected lifetime:** callers and adapters classify work in code; no tool parameter lets a model broaden lifetime or authority.
- **Inner-life effects:** autonomous wakes and proactive-contact consent belong to decision 0035 and `inner-life`. Pending delegated completion is claimed by authorized origin interaction, not by a parallel wake/effect engine.
- **Backend durability invention:** this change does not make an ACP definition resume-eligible or make a non-resumable backend survive process death.
- **Execution-environment mutation:** a run never follows later Surface assignment, a replacement Conversation, or an equal-CWD lane.
- **Storage-layout cleanup:** existing subagent and external-agent artifact directories remain in place; this change adds ownership/delivery metadata and a bounded pending index rather than hiding the separate no-scratch migration here.

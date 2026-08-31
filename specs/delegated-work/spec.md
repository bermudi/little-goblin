---
role: contract
owns: delegated-work-delivery
---

# Delegated Work: Durable Lifetime And Completion Delivery

Implements the durable half of decision 0036 on top of the decision-0045
record store. Attached-lifetime semantics are already CURRENT; this spec
owns only the durable addition.

## Requirements

1. WHEN a delegated run is spawned with durable lifetime, THE SYSTEM SHALL
   capture a record invocation with `lifetime: "durable"` and the full
   decision-0036 capture set (owner Conversation, runtime identity at spawn
   time, ownership epoch, origin Surface, immutable Execution Environment),
   and runtime invalidation or Conversation rotation SHALL NOT cancel,
   fence, or retarget it.
2. WHEN the spawn entry is used in background mode, THE SYSTEM SHALL return
   the run id to the calling turn immediately without blocking, and the
   blocking-call timeout SHALL NOT apply to the run.
3. WHEN a durable invocation completes AND its origin Surface is currently
   bound and authorized, THE SYSTEM SHALL deliver the result to that exact
   SurfaceId through the surface-bound system-turn rail without creating a
   Conversation, and SHALL mark the invocation delivered only after the
   send is accepted. Failed executions SHALL be suppressed, never
   auto-delivered.
4. WHEN a durable completion cannot be delivered (origin Surface unbound,
   send failure, or process restart with delivery still pending), THE
   SYSTEM SHALL retain it pending for that exact SurfaceId. WHEN the next
   authorized ordinary interaction occurs on that exact Surface, THE SYSTEM
   SHALL claim the pending completions oldest-first, bounded per claim, and
   deliver them. A guest Surface SHALL NOT claim without an authorized
   guest summon. No fallback routing SHALL occur.
5. WHEN the process starts AND a durable invocation is non-terminal, startup
   reconciliation SHALL mark it interrupted (the run died with the process);
   explicit revival SHALL append a new invocation continuing the persisted
   session state in place. Explicit cancellation from the owning
   Conversation SHALL remain destructive for durable runs.

## Scenarios

- **Background run survives rotation.** Spawn background in chat A, `/new`,
  run completes → chat A receives the result; the new conversation is not
  the owner; the record shows one durable invocation, completed, delivered.
- **Pending claim.** Origin Surface unbound at completion → completion stays
  pending; the user's next message on that exact Surface delivers the
  retained result before/with the normal turn; delivery state becomes
  delivered.
- **Restart truth.** Process dies mid-run → record shows the invocation
  interrupted after restart; revival continues the session as a new
  invocation; nothing silently resumes.
- **Owner cancellation.** Owning Conversation cancels the run → record
  terminal `cancelled`, delivery suppressed, execution fenced.

## Out of scope

External-agent durable runs (decision 0044 ACP cycle), inner-life consent
layering (decision 0035 — this is decision-0036 reactive completion contact,
not proactive contact), graceful shutdown drain of durable runs (process
death is honestly recorded as interruption), and any status-listing command
surface.

# Delegated Work Ownership

## Status

accepted

## Context

Subagents and external agents currently inherit ownership from the overloaded Goblin session/runtime seam. Conversation rotation, `/resume`, process restart, and Telegram destination loss can therefore cancel work that should survive, preserve work that no longer has authority, or deliver completion to whichever Surface happens to share a project directory later.

Execution Environment equality is only filesystem compatibility. It is not routing authority, and it cannot decide who should receive a delegated result.

## Decision

The delegated-run subsystem SHALL own each run record and its execution lifecycle. Every delegated work run SHALL also record an `ownerConversationId` for inspection, continuation, and explicit cancellation authority. `originSurfaceId` is delivery provenance, not control ownership; a current binding, another Surface, or an equal CWD MUST NOT confer control over a run.

Every delegated work run SHALL declare one of two lifetimes when it is created:

- **attached** work belongs to the creating Conversation runtime and SHALL be cancelled or terminally invalidated when that runtime is invalidated;
- **durable** work is not owned by a Conversation runtime and SHALL survive Conversation rotation and rebinding. Any stronger process-restart continuation guarantee remains specific to the delegated runner's protocol and persisted state.

Every work run SHALL capture an immutable Execution Environment and one origin `SurfaceId`. The environment bounds filesystem and project authority for the run. The origin Surface is the only destination for automatic or reactive completion contact; another Surface MUST NOT receive the result merely because it later binds the same Conversation or shares the same canonical CWD. Explicit status retrieval or continuation by the owning Conversation after it moves is permitted and is not automatic rerouting.

Conversation rotation MUST NOT retarget a durable run. Moving or replacing Conversation history does not change the run's origin Surface or environment. An attached run dies with the invalidated runtime even if another runtime is created for the same Conversation. Runtime invalidation cancels attached work only; explicit user cancellation by the owning Conversation remains destructive for both attached and durable work.

If the origin Surface is unavailable, execution MAY continue according to the run's declared lifetime and runner policy. Completion SHALL be retained as pending for that exact origin Surface and proactive contact SHALL be suspended. An unavailable or unbound origin Surface MUST NOT cause Conversation creation or fallback routing. The next authorized ordinary interaction on that exact Surface MAY claim the bounded pending completion; a guest Surface requires a later authorized guest summon from the same `SurfaceId`. Terminal run state and delivery state are separate: successful execution does not imply successful notification.

## Consequences

Delegated-run records need explicit subsystem ownership, `ownerConversationId`, lifetime, immutable environment, origin Surface, terminal outcome, and delivery state. Runtime disposal can make a principled cancellation decision instead of cascading through every run. Durable completion can survive Conversation changes without leaking to a convenient but unauthorized lane, while the owning Conversation can still inspect, continue, or explicitly cancel its work after moving.

The follow-up `delegated-work-ownership` change defines storage, cancellation races, pending-result claiming, migration defaults, and subagent/external-agent adapters. This decision does not claim that every external-agent backend can resume after process death, and it does not settle general Surface recovery or replacement policy.

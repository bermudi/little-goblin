# Surface And Conversation Lifetimes Are Separate

## Status

accepted

## Context

Goblin’s persisted `SessionState` currently stands for both a Telegram lane and conversational history. Its ID keys bindings, runner instances, queues, schedules, model preferences, and delegated work. `/new` and `/resume` consequently alter unrelated state, and `bindExistingToChat()` can leave one history active on several surfaces even though its runner contains surface-specific memory, tools, and delivery context.

The alternatives were to adopt OpenClaw-style `sessionKey`/`sessionId` terminology, keep one overloaded session with stricter call-site discipline, or separate routing and history by lifetime. Goblin already has a stable routing value (Surface), so introducing another session-key domain object would duplicate it.

## Decision

Goblin SHALL use these canonical meanings:

- **Surface**: a durable Telegram interaction and delivery lane.
- **Binding**: the current association from a Surface to a Conversation.
- **Conversation**: resumable conversational history, stored under the legacy `state/sessions/<id>/` path.
- **Conversation runtime**: the ephemeral `AgentRunner` and serialized prompt queue for one active Conversation.

A Surface MAY have at most one current Conversation, and a Conversation MAY be actively bound to at most one Surface. `/resume` of a bound compatible Conversation SHALL move the binding atomically rather than share one runtime across surfaces. Displaced conversations remain stored and resumable.

Model and thinking preferences, schedules, and heartbeat configuration SHALL be Surface-owned and survive `/new`. Conversation ID, name, creation time, transcript, events, metrics, pi history, and execution environment SHALL be Conversation-owned.

Authorized user interaction MAY lazily create a Conversation on an unbound Surface. Internal jobs, scheduler ticks, and proactive delivery MUST NOT create one implicitly.

“Session” SHALL remain only for pi’s `AgentSession`, compatibility symbols during migration, and the legacy filesystem path; new Goblin domain interfaces use “conversation.”

## Consequences

Conversation rotation no longer destroys surface configuration or automation. Named conversations can move safely among compatible surfaces after their old runtime is disposed. Scheduler and command code must resolve the current binding at execution time instead of treating a captured conversation as the delivery lane.

The lifecycle module must own atomic create/rotate/resume/archive operations so callers cannot produce partial binding state. Existing multi-bindings need migration. Work-run ownership and topic reachability remain separate decisions.

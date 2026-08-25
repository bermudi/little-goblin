# Defer live subagent cross-talk to v2

## Context

We have two patterns for subagent coordination in goblin:
- **Kind A (serial orchestration):** Goblin spawns subagent A, waits for result, then spawns B with A's output. Simple, predictable, single-threaded.
- **Kind B (live cross-talk):** Multiple subagents running concurrently, messaging each other via `message_sibling` / `ask_sibling` primitives. Parallel, complex state management.

## Decision

**Defer Kind B (live cross-talk / swarms) to v2.**

v1 implements Kind A only: serial orchestration + revival. Subagents complete before goblin continues.

## Rationale

1. **v1 scope control:** Cross-talk introduces distributed systems problems — race conditions, deadlock, partial failure, state synchronization — that are overkill for a single-user homelab bot.

2. **Serial is sufficient:** Most user requests are sequential: "research X, then write code using X's results, then deploy." The LLM already expresses this as step-by-step.

3. **Design reference ready:** The deferred work has a concrete reference implementation (`~/build/pi-messenger-swarm`) for when v2 work begins.

4. **API surface stays clean:** No half-implemented swarm primitives in v1 that we'd have to maintain or deprecate.

## Consequences

- Subagents in v1 cannot "phone a friend" while running. They finish, report back, and goblin decides next steps.
- User must wait for subagent A to complete before B starts. No parallel research + coding.
- Revival (returning to a finished subagent for follow-up) is supported — this is "resume a finished conversation," not "live cross-talk."

## Alternatives considered

- **Implement basic cross-talk now:** Rejected. Would add complexity without solving a v1 problem.
- **No subagents at all in v1:** Rejected. Named specialists (researcher, reviewer) are a core goblin concept.

## Related

- `specs/changes/subagent-runtime/` — v1 subagent implementation (serial only)
- `ROADMAP.md` — v2 item for live cross-talk / swarms

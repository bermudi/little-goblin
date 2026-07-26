# visible-dreaming (provisional)

## Status

**Blocked on `inner-life`. Do not build this change.**

This change intentionally contains only a placeholder proposal. Its previous specs, design, and tasks were withdrawn because they predated the agreed wake/reflection/presence architecture and falsely presented a parallel delivery system as implementation-ready. After `inner-life` is designed and implemented, this proposal and every downstream artifact SHALL be rewritten against that contract before implementation begins.

## Motivation

The memory engine already produces dream-diary material that could give Goblin a visible sense of continuity and interiority. Some of that material may eventually influence Goblin's presence or become a proactive utterance. The product intent remains useful; the mechanism is not yet settled.

## Dependency and rewrite boundary

`inner-life` must first define the shared concepts and ownership for:

- wakes and their causes;
- reflections or other internal observations;
- dispositions that may influence later behavior;
- presence policy, including whether Goblin should speak;
- proactive utterance routing and effect execution;
- user controls and delivery history shared by proactive behavior.

Only then can visible dreaming decide how dream output participates in those concepts. Dreaming should supply source material to inner life, not create a second proactive-delivery architecture.

## Withdrawn assumptions

The rewrite MUST NOT inherit these assumptions from the withdrawn artifacts unless `inner-life` explicitly establishes them as shared policy:

- dispatching dream output directly through `enqueueScheduledTurn()`;
- choosing a DM or “most recently created session” as a dream-specific destination;
- storing dream-specific consent preferences or delivery/throttle records;
- injecting a dream-specific aside directly from `AgentRunner` as a parallel presence mechanism;
- making the scheduler loop own distillation, presence decisions, routing, or delivery effects.

No current command surface, persistence schema, routing rule, cadence, consent model, or delivery format is approved by this placeholder.

## Scope

After the dependency lands, the future rewrite may cover:

- adapting grounded dream-diary output into the reflection/disposition model defined by `inner-life`;
- exposing dream history on demand without making export files authoritative runtime state;
- allowing shared presence policy to decide whether a dream-related proactive utterance is appropriate;
- executing any approved utterance through the shared effect and routing seams;
- testing that dream visibility obeys the same consent, suppression, destination, and observability rules as other inner-life behavior.

These are directions, not implementation requirements. The specs, design, and tasks remain absent until the dependency makes their contracts concrete.

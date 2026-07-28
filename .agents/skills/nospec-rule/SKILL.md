---
name: nospec-rule
description: Use to record an architectural ruling after the decision owner has explicitly accepted it or delegated decision authority.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Rule

An ADR records a decision already made. It does not promote an agent recommendation into project policy.

## Authority before durability

Write an accepted ADR only when one of these is true:

- the decision owner explicitly chose the direction;
- the owner explicitly delegated authority for this class of decision.

A requirement you observed, an option you recommend, or a trade-off still awaiting confirmation is not an accepted ruling. Keep proposals in conversation or disposable design material. In unattended batch work, a newly discovered consequential choice is a blocker; hand it back rather than deciding silently.

## When an ADR earns its weight

Use an ADR when the ruling is:

1. costly to reverse;
2. surprising without its rationale;
3. the result of a real trade-off among alternatives.

Skip choices obvious from code, local implementation details, and decisions that matter only for the current unit.

## Format

````markdown
---
nospec: true
id: NNNN
date: <YYYY-MM-DD>
status: accepted
spine: false
supersedes: [NNNN]          # only when replacing an earlier ADR
amends: [NNNN]              # only when narrowing or extending one
builds_on: [NNNN]           # only when deriving from one without changing it
---

# NNNN: <the ruling, not merely the topic>

## Context

<Problem, constraints, alternatives, and why a ruling was needed.>

## Decision

<The accepted choice and its reason.>

## Consequences

<What becomes easier, what becomes harder, and what to watch.>
````

Use the next zero-padded id in `decisions/`. Most ADRs have `spine: false`; set it true only for a load-bearing ruling that changes the project's thesis. Derive that list with `nospec spine`; never maintain another copy in prose.

Titles state the ruling. Context names genuine alternatives. Consequences include costs, not only benefits.

## Relationships and retirement

When replacing an ADR, mark the old one `status: superseded`, add `superseded_by: [NNNN]`, and point the new ADR back with `supersedes: [NNNN]`. `amends` and `builds_on` are one-way and leave the earlier ADR accepted.

After superseding a ruling, use `nospec-curator` to find views that still project the old one.

An ADR is orphaned when it no longer explains or constrains the current system. Citations are evidence of relevance, not the definition; negative rulings and conventions may remain relevant without an active caller. Retire records that no longer carry a live ruling.

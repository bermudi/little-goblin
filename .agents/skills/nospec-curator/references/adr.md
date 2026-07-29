# ADR

Read this only for an architectural ruling already accepted by the decision owner or under explicitly delegated authority. Proposals stay in conversation or disposable design material.

An ADR earns maintenance when the ruling is costly to reverse, surprising without rationale, or resolves a real trade-off. Skip obvious code choices, local details, and decisions confined to one work unit.

````markdown
---
nospec: true
id: NNNN
date: <YYYY-MM-DD>
status: accepted
spine: false
supersedes: [NNNN]  # only when replacing
amends: [NNNN]      # only when changing scope
builds_on: [NNNN]   # only when deriving without changing
---

# NNNN: <the ruling>

## Context
<Problem, constraints, and genuine alternatives.>

## Decision
<Accepted choice and reason.>

## Consequences
<Benefits, costs, and risks.>
````

Use the next zero-padded id. `spine: true` is only for a load-bearing ruling that changes the project's thesis; derive the list with `nospec spine` rather than copying it.

When replacing an ADR, mark the old one `superseded`, add `superseded_by`, and point back with `supersedes`. `amends` and `builds_on` leave the earlier ADR accepted. Add an inline note to an amended or superseded ADR so a cold reader sees the later ruling.

An ADR is orphaned only when it no longer explains or constrains the current system. Citations are evidence of relevance, not its definition. Retire records whose rulings are no longer live, and reconcile views after any relationship change.

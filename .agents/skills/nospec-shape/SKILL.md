---
name: nospec-shape
description: Use when work must be understood or bounded before implementation — clarifying intent, investigating uncertainty, decomposing outcomes, or preparing a cross-session or batch queue.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Shape

Turn intent into bounded, observable work. Scouting and decomposition are optional levels of one evidence-seeking stance; clear small changes go directly to `nospec-carve`.

## Raise fidelity only as needed

Read operational context, authoritative records, relevant code, tests, and history. Separate the desired outcome from its proposed solution; find existing paths and invariants.

When inspection cannot resolve a consequential question, read [`references/scouting.md`](references/scouting.md). A runnable experiment is evidence, not automatically production code.

Recommendations are not rulings. Present consequential choices to the decision owner; record them only after acceptance.

## Cut for useful evidence

One work unit produces one observable outcome. Choose the cut that exposes the relevant risk earliest:

- Use a **tracer bullet** when the uncertainty is whether components connect at all. It proves one representative path can cross the real boundaries, not that variants and edge cases work; without an integration assumption to test it is waste, and treating the trace as complete coverage hides breadth risk.
- Use a **vertical slice** when an observable behavior spans layers whose contracts may disagree. It proves those layers align for the chosen behavior, not that neighboring behavior is covered; a slice too thin gives false confidence, while one too broad delays the feedback it exists to obtain.
- Use **horizontal breadth** when an end-to-end contract is already proven and the remaining risk is consistent application across a layer or family of cases. It proves breadth against that contract, not integration; used before the contract is sound, it multiplies the same wrong assumption and postpones discovery.

A unit may carry `Read first:` context and `Constraints:` boundaries. It requires nonempty `Done means:` criteria and a mechanically checkable `Verify:` subset. The worker owns the implementation path; do not smuggle in an edit script.

Verification must fail when a believable implementation lacks the central outcome. Otherwise strengthen it, split the outcome, establish a better seam, or stay interactive. Review inspects the remaining judgment surface; it does not create deterministic proof.

## Disclose the applicable mode

Interactive shaping can remain conversational. Work specs are disposable; project-designated contracts remain durable.

- When execution needs a cross-session or batch handoff, read [`references/queue-format.md`](references/queue-format.md). Batch requires every unit to be bounded, runner-verifiable, and free of unresolved decisions.
- When the loop supplies `REVIEW.md` for conversion into new units, also read [`references/review-findings.md`](references/review-findings.md). This fixer mode appends queue units and never edits source.

Return clarified intent, bounded outcomes, an optional queue, a decision request, or justified no change. Do not manufacture a plan.

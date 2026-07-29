---
name: nospec-carve
description: Use when building or correcting production code — implementing one already-bounded outcome, conversationally or as one batch queue unit, including an accepted review correction.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Carve

Build one bounded outcome. A new capability and an accepted review correction use the same builder stance: find the governing invariant, make the smallest coherent change, and verify it.

Scope is the outcome plus its constraints, not a planner-supplied file list.

## Orient

Read the verify first, then the operational context, cited records, relevant code, tests, call sites, and any cycle design note. For a public surface, inspect its actual signatures, consumers, and project-designated contracts.

Extend the existing implementation path where possible. A parallel helper or abstraction creates another invariant to maintain.

When applying accepted review findings directly, read [`references/review-corrections.md`](references/review-corrections.md). Queue generation belongs to `nospec-shape`, not this skill.

## Work in feedback loops

Make the smallest coherent change that advances the outcome and exercise it early. Prefer structural edits to fragile text substitutions. Repeated failure means the diagnosis is weak: re-read the surrounding invariant instead of patching symptoms.

Keep unrelated cleanup out. Abstraction is justified only when the outcome requires it.

## Verify

- **Interactive:** run the narrowest credible verification. Report exactly what passed and what remains unverified.
- **Batch worker:** satisfy the unit's `Verify:` command, then stop. The runner executes it independently and owns queue status and `EVIDENCE.md`.

A passing command proves only what it exercises.

## Decisions and blockers

Reversible local implementation choices are worker-owned. A novel consequential trade-off is different: present it to the decision owner interactively, or report a blocker in batch unless authority was delegated. Never promote a preference into an accepted ADR.

Record an accepted ruling through the project's ADR practice; if installed, `nospec-curator` handles that routing. Capture durable operational discoveries only when they will matter later.

If the outcome cannot fit in one pass while leaving the repository coherent, stop with a precise handoff: what changed, what remains, what was verified, and what would unblock completion. The batch worker prompt supplies its additional mechanical protocol.

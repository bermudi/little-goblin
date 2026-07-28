---
name: nospec-carve
description: Use when implementing one already-bounded outcome, conversationally or as the worker for one batch queue unit.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Carve

Implement one bounded outcome. Scope is the outcome plus its constraints, not a planner-supplied file list.

## Orient before editing

Read the verify first. Then inspect the operational context, cited records, relevant code, tests, call sites, and any referenced cycle design note. For a public surface, inventory its actual signatures, consumers, and project-designated contracts; familiar names often hide unfamiliar obligations.

Find the existing implementation path and extend it where possible. A parallel helper or abstraction adds another invariant to maintain and verify.

## Work in feedback loops

Make the smallest coherent change that advances the outcome, then exercise it early. Do not accumulate a large untested diff.

Prefer structural edits to chains of fragile text substitutions. Diagnose repeated failures instead of patching symptoms: if the same area keeps failing, re-read the surrounding invariant before trying again.

Keep unrelated cleanup out. Abstraction is justified only when the outcome requires it.

## Verify before claiming success

- **Interactive:** run the narrowest credible verification yourself. Report exactly what passed and any remaining unverified surface.
- **Batch:** make the repository satisfy the unit's `Verify:` command, then stop. The runner executes it independently and owns status and `EVIDENCE.md`; do not edit either.

A passing command proves only what it exercises. Do not inflate it into architectural or semantic certainty.

## Decisions and blockers

Implementation may expose a trade-off the plan missed. Do not silently turn your preference into an accepted ADR. In interactive work, present the choice to the decision owner. In batch, a novel consequential decision is a blocker unless authority was explicitly delegated; report what must be decided and stop. Use `nospec-rule` to record a ruling only after acceptance.

Capture durable operational discoveries in the project's operational-context record. Route contradictory durable claims through `nospec-curator`. Do not create records for trivia.

If the outcome cannot fit in one pass while leaving the repository coherent, stop with a precise handoff: what changed, what remains, what was verified, and what would unblock completion.

When invoked by the batch runner, the worker prompt supplies the one-unit protocol and terminal handoff format.

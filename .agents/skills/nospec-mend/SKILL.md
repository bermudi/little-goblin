---
name: nospec-mend
description: Use when known review findings must be resolved directly or converted into narrow, verifiable batch work units.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Mend

Resolve findings without widening the change or oscillating between fixes.

Interactively, apply accepted fixes and verify them. In batch, do not edit source: triage `REVIEW.md`, append units for actionable findings to the existing queue, then stop so the runner can execute them.

## Triage

Respect the review classifications:

- **actionable** — resolve now or create a batch unit.
- **trivial** — optional non-blocking polish; do not create a batch unit.
- **disputed** — record the disagreement; do not act.
- **deferred** — valid but outside this work.
- **speculative** — no action without new evidence and reclassification.

If evidence contradicts a classification, say so rather than blindly queueing it.

## Diagnose before fixing

Read the cited evidence and surrounding code. Find the violated invariant, not only the symptom. Repeated attempts against the same failure mean the diagnosis is weak; stop patching and reassess.

A finding that requires choosing among architectural directions is not fix-ready. Ask the decision owner or block the batch cycle. Do not invent an accepted ruling to keep the loop moving.

## Batch units

Load `nospec-shape` and append one bounded unit per coherent actionable outcome. Each unit should:

- cite the review finding and evidence in `Read first:`;
- preserve constraints from the existing queue and any design note;
- include a no-regression acceptance criterion;
- verify both the correction and the behavior already approved where practical.

Do not reorder or rewrite existing units or statuses. `nospec lint` will preflight appended units before the next worker runs. If no actionable finding remains, append nothing.

A broad rewrite is new shaping work, not a mend unit.

## Output

- **Interactive:** applied fixes, triage decisions, and verification evidence.
- **Batch:** appended `Status: pending` units plus counts for actionable, trivial, disputed, deferred, and units appended. Stop after the queue edit; the runner owns orchestration.

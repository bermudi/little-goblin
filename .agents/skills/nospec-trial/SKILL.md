---
name: nospec-trial
description: Use for adversarial review of an existing change against repository standards and the stated intent it was meant to satisfy.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Trial

Review an existing change on two independent axes:

1. **Standards** — does it fit the repository's conventions and constraints?
2. **Intent** — does it satisfy the promised outcome beyond the narrow checks already run?

Review after reading the diff and available evidence. In a batch cycle, read the queue, `EVIDENCE.md`, and any provided design note. Interactively, recover intent from the request and conversation.

Use the authoritative source for each claim: code and tests for current implemented behavior, project-designated contracts for assigned promises, ADRs for rulings, the glossary for domain terms, operational context for repository practice, and the request or queue for current intent. Work specs are disposable; designated contracts are not. If ownership is unclear, surface that uncertainty rather than inferring it from a filename. Do not treat any one source as authority over every claim class.

## Standards axis

Compare the change with stated conventions and neighboring code. Look for:

- incorrect error handling, naming, layout, or test style;
- regressions, dead code, debugging residue, or unused paths;
- unnecessary wrappers, abstractions, and parallel implementations;
- stale projections after a public interface, ruling, term, or operational instruction changed.

A pin alert in `EVIDENCE.md` says a durable document moved; it is a prompt to inspect coherence, not proof of a defect. Use `nospec-curator` when durable records and views may disagree.

## Intent axis

Compare the actual behavior with the outcome and constraints. A passing verify establishes only its mechanical scope.

Probe plausible counterexamples outside that scope: variants, call order, side effects, short-circuit behavior, integration boundaries, and omissions. Ask how the result was produced, not only whether one visible value matched. Promote a concern only when the repository provides evidence for it.

Review can inspect the unverified acceptance surface; it cannot turn judgment into deterministic proof.

## Evidence and confidence

Every promoted finding cites an exact `path:line` and a short excerpt.

- **high** — direct evidence and a clear violation.
- **medium** — direct evidence, but interpretation or impact remains uncertain.
- **low or uncitable** — keep under `## Speculative`; do not count it as actionable.

This guard limits reviewer false positives. A plausible story without a cited premise is not a finding.

## Classification

- **actionable** — should be changed now and has one clear fix direction. Patch size is irrelevant.
- **trivial** — non-blocking polish that may be ignored; the batch runner does not send it to the fixer.
- **disputed** — evidence does not support the concern or project authority rejects it.
- **deferred** — valid, intentionally outside the current work.

If a one-line issue must be fixed before acceptance, classify it as actionable. Reviewers do not edit source or append queue units in batch; `nospec-mend` owns that conversion.

A fix direction is one unambiguous instruction, not a menu. If choosing a direction requires a new architectural ruling, report the decision need instead of laundering it into a fix.

## Batch output contract

Write the requested `REVIEW.md` with exactly these sections:

1. `## Standards`
2. `## Intent`
3. `## Speculative`
4. `## Summary`

Finding shape:

```markdown
- S1 | actionable | high
  evidence: `path/to/file:42` — "quoted code"
  finding: The change violates the repository's established parser boundary.
  fix direction: Route all queue consumers through the canonical parser.
```

Use `S`, `I`, or `X` ids for standards, intent, or speculative findings. Write `No issues found.` for a clean section.

The summary is machine-readable:

```markdown
## Summary
- standards: 1
- intent: 0
- speculative: 0
- actionable: 1
- trivial: 0
- disputed: 0
- deferred: 0
```

`- actionable: N` is the runner's continue/stop signal. Count only actionable findings. Interactively, communicate the same evidence without manufacturing a review artifact unless one is useful.

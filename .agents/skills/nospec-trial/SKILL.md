---
name: nospec-trial
description: Use for adversarial review of an existing change against repository standards and the intent it was meant to satisfy.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Trial

Adversarially challenge an existing change:

> How could this apparently successful change still be wrong?

Do not combine this stance with building. A reviewer who edits source tends to rationalize the implementation it just produced. Reviewers report findings; `nospec-carve` owns correction and `nospec-shape` owns batch-unit generation.

## Review two independent axes

1. **Standards** — fit with repository conventions, constraints, neighboring code, error handling, tests, and maintained records.
2. **Intent** — actual behavior versus the requested outcome and constraints beyond checks already run.

Read the diff and available evidence first. In batch, also read the queue, `EVIDENCE.md`, and any design note. Use the authority appropriate to each claim: code/tests for implemented behavior, designated contracts for assigned promises, ADRs for rulings, glossary for domain terms, operational context for repository practice, and request or queue for current intent. Surface unclear ownership rather than guessing from a filename.

A passing verify establishes only its mechanical scope. Probe plausible variants, call order, side effects, short-circuits, integration seams, and omissions. Promote a concern only when repository evidence supports it; a pin alert is a prompt to inspect coherence, not itself a defect.

## Evidence and classification

Every promoted finding cites an exact `path:line`, excerpt, violation, and one unambiguous fix direction.

- **high** — direct evidence and clear violation.
- **medium** — direct evidence, but interpretation or impact remains uncertain.
- **low or uncitable** — speculative; never actionable.

Classify supported findings as:

- **actionable** — should change now;
- **trivial** — optional non-blocking polish;
- **disputed** — evidence or project authority rejects it;
- **deferred** — valid but intentionally outside this work.

Patch size does not decide severity. If choosing a fix requires a new ruling, report the decision need rather than laundering it into a direction.

Interactively, communicate evidence directly without manufacturing an artifact. For runner-backed review, read [`references/batch-output.md`](references/batch-output.md).

---
name: nospec-scout
description: Use when the real problem or binding intent is unclear and codebase investigation or a bounded executable experiment is needed before choosing or decomposing work.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Scout

Reach clarity before committing work. The failure this skill prevents is precise execution against the wrong problem.

Scouting is human-present and starts read-only. It produces understanding, not a mandatory artifact or phase. Skip it when the task is already clear, such as a small fix with a reproduction.

## Read for the codebase's theory

Start with the project's operational context and authoritative records, then inspect the relevant code, tests, and history. Read to uncover constraints and prior choices, not to collect every fact.

Look for the existing path before proposing a new one. A nearby parser, helper, or convention may already encode edge cases that a parallel implementation would rediscover badly. Extend before duplicating.

## Challenge the request

Distinguish the desired outcome from the user's guessed solution:

- What is actually failing or missing?
- What must remain true?
- What would count as success?
- Which assumptions are uncertain?
- Is the named problem a cause or a symptom?

Use concrete counterexamples. Ask what breaks under the proposed approach, what the simplest viable alternative is, and whether the repository already prefers another shape.

## Raise fidelity with executable scouting

When inspection and discussion cannot resolve a consequential question about how something should look, behave, or fit the real system, build the cheapest runnable experiment that can. A prototype may exercise UI interaction, an integration seam, or pure logic such as a state machine. Its outcome is an answer, not production code.

Before writing it, state the question and what observation would answer it. Keep the experiment bounded and isolate throwaway edits in a disposable worktree or branch when they should not enter the current change. Sandbox external effects and real data. Write only enough code to expose the uncertainty; production concerns deliberately omitted by the experiment remain unproven.

React to the running artifact while the human is present. Treat prototype code as evidence, not authority: extract the clarified outcome and any accepted ruling, then discard the throwaway implementation. Do not silently promote it into production. If the code is meant to remain, it is implementation rather than a prototype and needs the normal tests, review, and verification.

Executable scouting is an option, not a required phase. Prefer reading or discussion when lower-fidelity evidence can answer the question more cheaply.

## Report the useful result

Return the real problem, relevant evidence, constraints, and recommended next action. That action may be direct editing, `nospec-shape`, a decision request, or no change at all. Do not automatically manufacture a plan.

A recommendation is not an accepted ruling. If exploration exposes a consequential trade-off, present it to the decision owner. Use `nospec-rule` only after the owner accepts a direction or has explicitly delegated that authority. Resolve recurring ambiguous domain language with `nospec-lexicon`.

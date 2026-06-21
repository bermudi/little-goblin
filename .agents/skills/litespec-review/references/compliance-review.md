Compliance review checks implementation for spec compliance, design adherence, and pattern coherence. It applies conservative heuristics — prefer false negatives, flag only what you can prove.

---

## Completeness — Is everything that should be there, there?

- **Task completion**: Parse `tasks.md`. Every `- [ ]` in the current or earlier phase is a gap. Every `- [x]` is done. Flag unchecked tasks.
- **Spec coverage**: For each requirement in the specs, find implementation evidence in the codebase. A requirement with no matching code is incomplete.
- **Orphaned code**: Code that implements something not found in any spec or task. Flag it — it may be valid, but it needs explanation.

---

## Correctness — Does the implementation do what the specs say?

- **Requirement-to-implementation mapping**: Each `### Requirement:` marker in a spec should map to a concrete code location. If the mapping is missing or the code contradicts the requirement, flag it.
- **Scenario coverage**: Each `#### Scenario:` in a spec describes expected behavior. Trace through the implementation and confirm the scenario is handled. Missing scenarios are correctness issues.
- **Edge cases**: Specs often describe edge cases explicitly. Check that the code handles them. Do not invent edge cases the specs do not describe — that is adversarial review's job.

---

## Coherence — Does the implementation fit the system?

- **Design adherence**: Does the implementation follow design.md? If the design says "use event sourcing" and the code uses direct CRUD, flag the mismatch.
- **Pattern consistency**: Does the new code follow patterns already established in the codebase? Inconsistent error handling, naming, or structure is a coherence issue.
- **Architectural alignment**: Does the change respect the system's architecture? Cross-layer violations, wrong dependency directions, misplaced abstractions — flag them.

---

## Heuristics

- **Prefer specificity over silence.** Only flag what you can trace to a concrete code path with file:line anchors. If you cannot trace the issue, move it to an Observations section tagged [unconfirmed] rather than inflating the findings. Untraced findings are worse than no findings — they trigger overcorrection in the fixer.
- **Every issue needs a specific, actionable recommendation.** "Fix this" is not actionable. "Add input validation in `handler.go:42` per spec requirement R-003" is.
- **Guard against overcorrection.** Do not flag any of these without a traced code path demonstrating the issue:
  - **Logic Error** — claiming an algorithm is wrong without a falsifying counterexample (input → expected → actual)
  - **Added Requirement** — rejecting code for not implementing something the spec doesn't require
  - **Boundary Error** — asserting off-by-one errors in correct code without showing the exact index mismatch
  - **Misread Spec** — misinterpreting stated requirements to justify a finding
  These four patterns account for 87%+ of false negatives in LLM code review. A finding without evidence is noise.
- **Graceful degradation.** If some artifacts are missing (no design.md, incomplete specs), work with what you have. State what was unavailable at the top of the report and exclude dimensions you could not evaluate.
- **No speculation.** Do not imagine bugs. Do not flag theoretical risks. Only flag concrete, observable gaps between specs and implementation. (Adversarial scenario construction is adversarial review's job.)

---

## Scorecard

| Dimension              | Pass | Fail | Not Evaluated |
|------------------------|------|------|---------------|
| Interaction Correctness| N    | N    | N             |
| Test Adequacy          | N    | N    | N             |
| Completeness           | N    | N    | N             |
| Correctness            | N    | N    | N             |
| Coherence              | N    | N    | N             |
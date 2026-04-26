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

- **Prefer false negatives.** Only flag what you can verify from reading the code and specs. If you are unsure, do not flag it. A noisy report is worse than a permissive one.
- **Every issue needs a specific, actionable recommendation.** "Fix this" is not actionable. "Add input validation in `handler.go:42` per spec requirement R-003" is.
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
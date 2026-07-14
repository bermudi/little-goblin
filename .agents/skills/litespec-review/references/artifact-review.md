Use this mode when zero tasks are checked. The change is planned but not yet implemented. Your job is to review the planning artifacts for quality, consistency, and readiness — not to review code.

Read: proposal.md, specs/, design.md, tasks.md. Do NOT read implementation files.

---

## Dimensions

### Completeness — Is everything that should be there, there?

- **All artifacts present**: Are proposal, specs, design, and tasks all present and non-empty?
- **Spec coverage**: Do specs cover the full scope described in the proposal? Any proposal scope items with no matching spec requirements?
- **Scenario coverage**: Does every requirement have at least one scenario with concrete WHEN/THEN conditions?
- **Task coverage**: Do tasks reference every design decision? Are there design changes with no corresponding tasks?

### Consistency — Do the artifacts agree with each other?

- **Proposal vs specs**: Do spec requirements stay within proposal scope? Flag any requirement that contradicts a non-goal.
- **Design vs specs**: Does design.md describe changes that align with spec requirements? Flag mismatches.
- **Tasks vs design**: Do tasks cover the file changes listed in design.md? Missing file changes are gaps.
- **Non-goal violations**: If the proposal lists something as a non-goal, flag any artifact that implements or depends on it.

### Readiness — Can implementation start without ambiguity?

- **Testable scenarios**: Each scenario must describe concrete WHEN/THEN conditions. Vague scenarios ("works correctly") are readiness issues.
- **Concrete design**: Does design.md specify file paths, function signatures, or data structures? Abstract designs without concrete details are readiness issues.
- **Phased tasks**: Are tasks organized into phases with clear boundaries? Can each phase be completed independently?
- **Clear acceptance criteria**: Can each task be unambiguously marked done? Subjective tasks are readiness issues.

---

## Heuristics

- **This is judgment-based review.** `litespec validate` catches syntax and structural issues. You catch quality gaps.
- **Every issue needs a specific, actionable recommendation.** "Improve this" is not actionable. "Add a scenario to requirement X describing the expected error when input is empty" is.
- **Prefer false negatives.** Only flag what you can clearly articulate. A noisy report is worse than a permissive one.

---

## Scorecard

| Dimension     | Pass | Fail | Not Evaluated |
|---------------|------|------|---------------|
| Completeness  | N    | N    | N             |
| Consistency   | N    | N    | N             |
| Readiness     | N    | N    | N             |
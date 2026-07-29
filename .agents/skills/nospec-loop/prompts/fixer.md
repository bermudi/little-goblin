# Nospec Fixer

Load **nospec-shape** and follow its `references/review-findings.md` branch. Convert actionable findings from `Review input:` into appended queue units, then stop.

Read `AGENTS.md`, `Queue:`, and any design note. Do not edit source, review, evidence, existing units, or statuses. Append only parser-valid `Status: pending` units with nonempty `Done means:` and discriminating deterministic verifies. Report a blocker instead of encoding a new decision or broad redesign.

```text
Fix: <cycle name>
Units appended: <count>
Notes: <blockers or caveats>
```

# Nospec Fixer

Load and follow **nospec-mend**. Convert actionable review findings into appended queue units, then stop.

Batch constraints:

- Read `AGENTS.md`, `Review input:`, `Queue:`, and any optional design note.
- Do not edit source, review, evidence, existing units, or statuses.
- Append only parser-valid, narrow `Status: pending` units with nonempty `Done means:` and discriminating deterministic verifies.
- If a finding requires a new decision or broad redesign, report the blocker instead of inventing a unit.
- End after updating the queue.

Terminal handoff:

```text
Fix: <cycle name>
Units appended: <count>
Notes: <blockers or caveats>
```

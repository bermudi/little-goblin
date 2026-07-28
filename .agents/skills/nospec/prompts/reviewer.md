# Nospec Reviewer

Load and follow **nospec-trial**. Review the completed queue against the current repository, then stop.

Batch constraints:

- Read `AGENTS.md`, the supplied queue, evidence, and optional design note.
- Write the skill's structured artifact to `Review output:`.
- Do not edit source, queue, evidence, or implement fixes.
- Promoted findings require cited `file:line` evidence. Uncitable concerns stay speculative.
- A finding that must be fixed is `actionable`, even when the patch is trivial.
- End after writing the artifact.

Terminal handoff:

```text
Review: <cycle name>
Actionable: <count>
Standards: <count>
Intent: <count>
Notes: <blockers or caveats>
```

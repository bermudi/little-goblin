When you are asked to fix, address, or resolve review findings (rather than implementing tasks from tasks.md), different rules apply. The review found symptoms; your job is to cure the disease.

**Behavioral shift — scope expands, does not narrow:**
- For each finding, identify the **abstract pattern** behind it. Do not fix just the reported `file:line`
- Search the entire affected module (or modules) for the same pattern. Fix all instances, not just the reported one
- If the review included **Pattern Annotations**, use them as your roadmap — confirmed locations must be fixed, likely locations must be verified and fixed if the pattern holds
- After fixing, re-read the entire affected module end-to-end. Ask: "Did my changes introduce new surface area? What invariants might now be broken?"
- Run the full test suite, not just tests related to your fix

**Priority order:** CRITICAL → WARNING → SUGGESTION. Group findings by file. Address each individually, verifying per fix before moving on.

**Per-finding loop:**

For each finding (CRITICAL → WARNING → SUGGESTION), grouped by file:

1. Read the finding and the relevant source file(s). If a finding references a spec requirement, read that spec section first
2. Search the module for the same pattern — fix all instances, not just the one cited
3. Make the minimal change
4. Run the project's build command and relevant tests. If both pass, move on. If either fails, fix and retry
5. If the same verification failure occurs twice in a row on the same finding, stop. State what failed and re-read the finding and code before attempting again
6. State what was fixed and where

**Final verification after all findings:**

1. Run the project's build command
2. Run the project's test suite
3. Run `litespec validate <name>`

Fix any failures before proceeding.

**Verification:**
After all fixes, verify:
1. Every location in every Pattern Annotation is addressed
2. No new unguarded paths were introduced by the fix
3. Run `litespec validate <name>` to confirm no structural regressions
4. The full test suite passes
5. A re-read of the affected module reveals no remaining instances of the pattern

**Escalation:**
If a finding cannot be resolved:
- State it explicitly: "Finding [X] in `file:line` could not be resolved because [reason]"
- Never silently skip a finding
- Escalate unresolvable findings as an explicit warning rather than silently dropping them
- Suggest next steps (update design.md, re-explore the problem)

**What NOT to do:**
- Do not fix only the specific `file:line` from the report while ignoring structurally identical code nearby
- Do not declare done after tests pass without re-reading the changed module
- Do not treat SUGGESTIONs as optional if they share a pattern with CRITICALs or WARNINGs — the pattern is the problem, not the severity tag
- Do not modify specs, proposal, design, or tasks — fix implementation code only
- Do not stop to ask for confirmation after presenting the work list — start fixing immediately

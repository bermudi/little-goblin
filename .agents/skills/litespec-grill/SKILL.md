---
name: litespec-grill
description: Interview the user relentlessly about a plan or design until reaching shared understanding. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview the user relentlessly about a plan or design until reaching shared understanding.

Think hard about the implications of each question before asking and use your expertise to guide.

Resolve each branch of the decision tree, one question at a time.

Provide your recommended answer for each question.

If a question can be answered by exploring the codebase, explore it instead of asking.

When a locked architectural ruling emerges that is broader than the current change, suggest creating a decision via `litespec decide <slug>` rather than burying it in design.md.

**Backlog scope challenge:** If `specs/backlog.md` exists, read it and challenge scope overlaps between the current plan and parked items.

When the plan is fully resolved, offer to proceed to propose.

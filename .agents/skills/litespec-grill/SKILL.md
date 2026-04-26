---
name: litespec-grill
description: Interview the user relentlessly about a plan or design until reaching shared understanding. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview the user relentlessly about a plan or design until reaching shared understanding.

If this grill call follows exploration in the current session, build on what was already discussed. Do not re-explore from scratch.

Think hard about the implications of each question before asking and use your expertise to guide.

Resolve each branch of the decision tree, one question at a time.

Provide your recommended answer for each question.

**Read code, do not speculate.** If a question can be answered by reading the codebase, read the code instead of asking. If you're unsure how something works, grep for it before posing it as a question to the user.

When a locked architectural ruling emerges that is broader than the current change, suggest creating a decision via `litespec decide <slug>` rather than burying it in design.md.

**Backlog scope challenge:** If `specs/backlog.md` exists, read it and challenge scope overlaps between the current plan and parked items.

**Glossary awareness:** If `specs/glossary.md` exists, read it at session start to speak the same language as the project. When a new term crystallizes from the discussion, nudge: "This looks like a term for the glossary — want me to add it?"

When the plan is fully resolved, offer to proceed to propose.

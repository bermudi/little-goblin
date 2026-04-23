---
name: litespec-workflow
description: Explain the litespec workflow and determine the user's current phase. Use when the user asks how litespec works, what the workflow is, what to do next, or says "workflow".
---

Explain the litespec workflow and determine the user's current phase.

**The workflow is unidirectional:**

```
explore → grill → propose → [research →] apply → review → archive
                                          │
                                      adopt (separate path)
```

**explore** — Think freely. No artifacts, no change directory. Read code, ask questions, map architecture. Never implement.
**grill** — Stress-test a plan. Relentless Q&A on tradeoffs, risks, edge cases. No artifacts.
**propose** — Materialize the change. Creates proposal.md, specs/, design.md, tasks.md.
**research** — Gather external knowledge (APIs, libraries, schemas). Produces research skills. Optional.
**apply** — Implement one phase at a time. One session per phase, one commit per phase.
**review** — Context-aware review: artifacts (pre-impl), code vs specs (during), both (pre-archive).
**archive** — Apply deltas to canonical specs and move the change to archive. The commit to implemented.
**adopt** — Reverse-engineer specs from existing code. Separate path, does not use propose/apply.

---

## Gotchas

- **explore and grill are ephemeral** — They produce no artifacts and no change directory. The AI keeps context in its window. If the user wants to save thinking, move to propose.
- **propose is the commit point** — Once artifacts exist on disk, the plan is committed. If scope or design is wrong after propose, start over from explore/grill. No backward flow. This prevents drift.
- **Phase tracking comes from tasks.md checkboxes** — There is no metadata field. The first phase with unchecked tasks is the current phase. Re-invoke litespec-apply for each phase.
- **The CLI is read-only** — The AI never writes through the CLI. It reads status/instructions/validation and writes artifact files directly.
- **Research skills persist after archive** — They accumulate as project knowledge in .agents/skills/research-<topic>/.
- **validate detects dangling deltas early** — Not just at archive time. Run it during apply to catch spec drift.
- **Decisions are opt-in** — No error if specs/decisions/ is empty. Created via litespec decide when architectural rulings span changes.
- **archive is not "implement"** — apply is implement. archive commits deltas to canonical specs (specs/canon/).

---

## Progressive Discovery

Do not dump the full workflow on the user. Detect their current state and explain what matters next.

### Detect state

Run these commands silently:

```bash
litespec list --json
litespec status --json
```

**Interpreting litespec list --json:**
- changes[].status: "in-progress" = active, "complete" = ready to archive
- changes[].completedTasks / totalTasks: 0/0 = draft, N/M = active, M/M = ready
- changes[].lastModified: use to find the most recently touched change

**Interpreting litespec status --json:**
- artifacts[].status: "ready" = not yet created, "done" = file exists
- isComplete: true when all artifact files exist. This does NOT mean tasks are checked — check list --json for task progress

### If no project exists

The user needs litespec init. Explain that init creates the specs directory and generates skills for their AI tools.

### If project exists but no changes

The user is at the start. Explain explore -> grill -> propose as the path to creating their first change. Mention adopt as an alternative if they have existing code to document.

### If changes exist

Find the most relevant change (user-mentioned, or most recently touched) and explain its current phase:

**No tasks yet (draft)** — totalTasks == 0. No tasks.md or empty tasks.md. The change may have proposals/specs/design but no implementation plan yet. Next: write tasks.md or run litespec-propose if artifacts are missing.

**Tasks exist, not all done (active)** — totalTasks > 0 and completedTasks < totalTasks. The change is being implemented. Show progress and identify the current phase (first unchecked tasks block in tasks.md). Next: litespec-apply for that phase.

**All tasks done (ready to archive)** — completedTasks == totalTasks > 0. Implementation is complete. Next: litespec-review then litespec-archive.

### If archived changes exist

Point to the canonical specs as the source of truth. Changes in specs/canon/ describe the implemented system.

---

## When the user asks "what do I do next?"

Use this response template:

> **Current state:** [X active changes, Y ready to archive]
> **Most relevant:** [change-name] at [N/M phases]
> **Next step:** [specific command or skill]
> **Why:** [brief reason]

Example:
> **Current state:** 1 active change
> **Most relevant:** auth-refactor at 2/4 phases
> **Next step:** Run litespec-apply to implement Phase 3
> **Why:** Phase 3 is the first unchecked task block in tasks.md

---

## Common questions

**"Can I skip explore/grill?"** — Yes. If you already know what you want, go straight to propose.

**"Something is wrong after propose, can I edit?"** — No backward flow. Start over from explore/grill. This prevents drift between plan and implementation.

**"What is research for?"** — External knowledge gaps. Skip it if you know the APIs/libraries cold.

**"When do I review?"** — Three times: after propose (artifacts), during apply (code vs specs), before archive (both). The review skill adapts automatically.

**"What is adopt?"** — A separate path. Give it code, it reverse-engineers specs. No propose, no apply, no archive.

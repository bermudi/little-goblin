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

patch → archive  (lightweight lane for small, single-capability changes)
```

**explore** — Think freely. No artifacts, no change directory. Read code, ask questions, map architecture. Never implement.
**grill** — Stress-test a plan. Relentless Q&A on tradeoffs, risks, edge cases. No artifacts.
**propose** — Materialize the change. Creates proposal.md, specs/, design.md, tasks.md.
**research** — Gather external knowledge (APIs, libraries, schemas). Produces research skills. Optional.
**apply** — Implement one phase at a time. One session per phase, one commit per phase.
**review** — Adversarial + compliance review: artifacts only (pre-impl), adversarial then compliance (during), adversarial + compliance + build verification (pre-archive).
**archive** — Apply deltas to canonical specs and move the change to archive. The commit to implemented.
**adopt** — Reverse-engineer specs from existing code. Separate path, does not use propose/apply.
**patch** — Lightweight lane for small changes. `litespec patch <name> <capability>` creates a delta-only change (no proposal/design/tasks). Use when the change is small, single-capability, and needs no design discussion.

---

## Gotchas

- **explore and grill are ephemeral** — No artifacts, no change directory. To save thinking, move to propose.
- **propose is the commit point** — Once artifacts exist on disk, the plan is committed. If scope or design is wrong after propose, start over from explore/grill. No backward flow.
- **Phase tracking comes from tasks.md checkboxes** — No metadata field. The first phase with unchecked tasks is the current phase. Re-invoke litespec-apply for each phase.
- **The CLI is read-only** — The AI reads status/instructions/validation and writes artifact files directly.
- **Research skills persist after archive** — They accumulate in .agents/skills/research-<topic>/.
- **validate detects dangling deltas early** — Run it during apply to catch spec drift.
- **Decisions are opt-in** — Created via `litespec decide` when architectural rulings span changes.
- **archive is not "implement"** — apply is implement. archive commits deltas to canonical specs.
- **Archive is a human decision** — the agent never runs `litespec archive`. After review, tell the user to run it themselves. It is the final stamp of approval.

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

The user needs `litespec init`. Explain that init creates the specs directory and generates skills for their AI tools.

### If project exists but no changes

Read `references/onboarding.md` — distinguish first-time users from experienced users between changes, and handle each appropriately.

### If changes exist

Find the most relevant change (user-mentioned, or most recently touched) and explain its current phase:

**No tasks yet (draft)** — totalTasks == 0. Next: write tasks.md or run litespec-propose if artifacts are missing.

**Tasks exist, not all done (active)** — totalTasks > 0 and completedTasks < totalTasks. Show progress and identify the current phase (first unchecked tasks block in tasks.md). Next: litespec-apply for that phase.

**All tasks done (ready to archive)** — completedTasks == totalTasks > 0. Next: run `litespec-review`, then tell the user to run `litespec archive <name>` when they're satisfied. Archive is the human's final stamp of approval.

### If archived changes exist

Point to the canonical specs as the source of truth. Changes in specs/canon/ describe the implemented system.

---

## When the user asks "what do I do next?"

Use this response template:

> **Current state:** [X active changes, Y ready to archive]
> **Most relevant:** [change-name] at [N/M phases]
> **Next step:** [specific command or skill]
> **Why:** [brief reason]

---

## Common questions

Read `references/faq.md` when the user asks workflow questions.

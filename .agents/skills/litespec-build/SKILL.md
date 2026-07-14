---
name: litespec-build
description: Implement litespec changes phase by phase, fix review findings, and research knowledge gaps. Use when the user wants to start coding, implement tasks, fix review feedback, research external dependencies, or says 'apply', 'implement', 'fix', or 'research'.
---

Build is execution mode. You implement tasks, fix review findings, and research knowledge gaps — one phase at a time, with discipline.

**IMPORTANT: You are an implementer, not a designer.** Your job is to turn clear tasks into working code. You do not invent scope, you do not refactor beyond what the task asks, and you do not guess. If something is unclear — pause and ask.

---

## Setup

Run `litespec status <name> --json` to verify all artifacts are ready.

Read whatever change artifacts exist — proposal.md, design.md, specs/, tasks.md. All are in `specs/changes/<name>/`. You need full context before writing a single line of code. Also read the relevant source files in the codebase — implementing without understanding existing code produces rework.

If required artifacts (proposal, design, tasks, specs) are missing, stop. Tell the user to create them first.

---

## Phase Workflow

**One phase per session. This is non-negotiable.** Litespec's strength is controlled, incremental progress.

1. **Identify the current phase** — `currentPhase` points to it in the phases array
2. **Read the phase tasks** — understand every task before starting any of them
3. **Implement each task sequentially** — one at a time, in order
4. **Mark tasks done immediately** — edit `tasks.md` and set `[x]` the moment a task is complete
5. **Commit your work after the phase** — message: `phase N: <phase name>`
6. **Stop** — tell the user the phase is done and they can re-invoke build for the next one

---

## Research Pause

When you encounter a knowledge gap during implementation — novel APIs, unfamiliar libraries, non-obvious authentication flows — pause and gather the relevant documentation.

You MAY produce a research skill file at `.agents/skills/research-<topic>/SKILL.md` for future reference. If produced, it SHALL use skill-creator format conventions and persist after archive as accumulated project knowledge.

This is not a separate phase. It is an inline step within the build workflow. Skip it when you already know the APIs/libraries cold; go deep when the knowledge is genuinely novel.

---

## Fixing Review Findings

Read `references/review-fixing.md` for the full review-fixing workflow.

---

## Behavioral Guardrails

- **Make minimal, scoped changes** — implement exactly what the task requires, nothing more
- **Do not refactor beyond scope** — even if you see something ugly nearby. Note it, do not fix it
- **Do not guess on unclear tasks** — if a task is ambiguous, pause and ask before proceeding
- **Mark tasks `[x]` immediately** — do not batch-mark at the end. Each completion gets its own edit
- **If a task requires artifact changes** (design, specs, proposal), note it and pause. Do not modify artifacts yourself
- **One phase per commit** — no more, no less

---

## Pause Conditions

Stop and ask the user before continuing if:

- **A task is unclear or ambiguous** — you cannot determine what "done" looks like
- **A design issue is discovered** — the implementation reveals a flaw or gap in the design
- **An error or unexpected behavior is encountered** — something does not behave as the specs predict
- **A knowledge gap is hit** — you need external documentation for an unfamiliar API or library
- **The user interrupts** — respect the signal, summarize progress, and wait
- **A task requires artifact changes** — specs, design, or proposal need updating before work can proceed

When you pause: state clearly what stopped you, what you need to proceed, and what you have completed so far.

---

## Ending

After completing a phase, report:
- What was implemented
- Any issues or notes surfaced during implementation
- That the user can re-invoke build for the next phase

Do not offer to start the next phase yourself. One phase. Stop.

When fixing review findings, list every finding and its resolution (fixed / escalated / skipped with reason), suggest the user run review to verify, and commit: `fix: address review findings for <change-name>`.

---

## References

`specs/glossary.md` — the project's ubiquitous language. You may consult it for terminology after completing a phase. No enforcement, purely optional context.

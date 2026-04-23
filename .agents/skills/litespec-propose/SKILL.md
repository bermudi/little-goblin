---
name: litespec-propose
description: Materialize a complete change proposal with all planning artifacts (proposal, specs, design, tasks). Use when the user wants to create a new change, start a feature, or says "propose".
---

Enter propose mode. Your job is to materialize a complete change proposal from conversation context and codebase understanding onto disk.

---

## Setup

Ask the user what they want to build. Derive a kebab-case change name from the description.

Then check if it already exists:
```bash
litespec status <name> --json
```

**If the change exists**, pick up where it left off — check which artifacts are already done and continue from the next missing one. Do not re-create completed artifacts.

**If the change does not exist**, create it:
```bash
litespec new <name>
```

---

## The Loop

Work through artifacts in dependency order. Repeat until all artifacts are created:

1. **Check status:**
```bash
litespec status <name> --json
```
   Response: `{changeName, schemaName, isComplete, artifacts: [{id, outputPath, status, missingDeps}]}`

2. **Get instructions for the next "ready" artifact:**
```bash
litespec instructions <artifact-id> --json
```
   Response: `{artifactId, description, instruction, template, outputPath}`

3. **Read dependency files** — earlier artifacts in the dependency order (proposal → specs → design/tasks) are inputs that inform the current artifact.

4. **Create the artifact file** at `outputPath`, using the template structure as a guide.

5. **Verify the file exists** after writing it. If it did not land, write it again.

6. **Loop** back to step 1 until `isComplete` is true.

7. **Validate the artifact** — run `litespec validate <artifact-id>` to make sure the artifacts pass validation.

---

## Context and Rules Are Constraints, Not Content

Each artifact comes with `instruction`, `template`, and `dependencies`. Use these to guide your thinking and structure — **do not paste them into artifact files**.

- `instruction` and `template` tell you *what to produce and how to shape it*. They are your brief.
- `dependencies` provide *source material to reference and build on*, not text to copy.
- The artifact file should contain original, purposeful content — not a regurgitation of the instructions.

---

## Spec Format

Write delta specs in this exact structure:

    # <capability>                    (optional heading)
    ## ADDED Requirements
    ### Requirement: <name>
    <body text — must contain SHALL or MUST>

    #### Scenario: <short name>
    - **WHEN** <condition>
    - **THEN** <expected outcome>

    ## MODIFIED Requirements
    ### Requirement: <name>
    <full replacement including scenarios>

    ## REMOVED Requirements
    ### Requirement: <name>            (name only, no body or scenarios)

    ## RENAMED Requirements
    ### Requirement: <old> → <new>     (preserves body and scenarios)

Rules:

- Every ADDED and MODIFIED requirement must include at least one `#### Scenario:` block
- Scenario text describes expected behavior — WHEN/THEN is the recommended format
- REMOVED requirements are name-only
- RENAMED requirements change the heading only; content and scenarios carry over

---

## Behavioral Guardrails

- **Verify every file after writing.** Confirm the artifact landed at `outputPath`. If it did not, write it again before moving on.
- **Decide, do not block.** If the user is vague or a detail is unclear, make a reasonable decision and note what you chose in the artifact. The user can correct it during apply or review. Momentum matters more than perfection at this stage.
- **Resume, do not restart.** If the change already exists, check status and continue from the first incomplete artifact. Never overwrite completed work.
- **Show a summary when done.** After all artifacts are created, print a brief summary of what was created and the file paths. Then suggest next steps:
  - `apply` to start implementing
   - `review` to review the proposal against specs

**Standing rules check:** During design.md authoring, check whether any language sounds like a cross-cutting rule ("all changes must...", "we will never..."). If so, suggest citing an existing decision from `specs/decisions/` or creating one via `litespec decide <slug>`.

---

## What You Are Doing

Turning conversation and codebase understanding into a structured, actionable change proposal. The four artifacts — proposal, specs, design, tasks — form a contract. Get them on disk, get them right enough, move on.

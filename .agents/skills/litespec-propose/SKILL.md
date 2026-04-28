---
name: litespec-propose
description: Materialize a complete change proposal with all planning artifacts (proposal, specs, design, tasks). Use when the user wants to create a new change, start a feature, or says "propose".
---

Enter propose mode. Your job is to materialize a complete change proposal from conversation context and codebase understanding onto disk.

If this propose call follows exploration or grilling in the current session, distill from that conversation. Do not re-grill the user. Do not re-author from scratch. Your job is high-fidelity transcription — the decisions are settled, your task is to serialize them across artifacts without losing fidelity between them.

If this is a standalone propose (no prior exploration/grill), you are making decisions as you go. Either way, the verification checkpoints in the loop below are not optional.

---

## Setup

Ask the user what they want to build. Derive a kebab-case change name from the description.

Before writing anything, identify which existing capabilities and code paths the change touches. Read the canon files in `specs/canon/<capability>/` and the relevant source files. Speculation about behavior you have not read produces broken proposals.

If your proposal touches more than 3 capabilities or mixes unrelated concerns, pause and ask the user whether this should be split into multiple changes.

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

3. **Read dependency files** — read every dependency file before writing. Do not write design.md without reading proposal.md and the deltas. Do not write tasks.md without reading all three. Earlier artifacts in the dependency order (proposal → specs → design/tasks) are mandatory inputs, not optional context.

4. **Create the artifact file** at `outputPath`, using the template structure as a guide.

5. **Verify the file exists** after writing it. If it did not land, write it again.

6. **Cross-check** — after writing specs, re-read your proposal alongside each spec delta. Ask: does any spec assert behavior the proposal excludes? Do any two specs contradict each other on the same concept? Fix before moving on.

7. **Check structure** — run `litespec validate <name>` (where `<name>` is the change directory name). This catches formatting issues (missing scenarios, malformed deltas, requirement-name conflicts). It does NOT check semantic consistency — that was your job in step 6.

8. **Loop** back to step 1 until `isComplete` is true.

---

## Context and Rules Are Constraints, Not Content

Instructions and templates tell you what to produce and how to shape it — they are your brief, not your output. Dependencies provide source material to build on, not text to copy. Write original content informed by them.

---

## Spec Format

Before writing a delta for capability X, read `specs/canon/X/spec.md` if it exists. ADDED vs MODIFIED vs RENAMED is a function of what already exists.

Delta spec structure — `litespec instructions specs --json` returns this at runtime, summarized here for convenience:

    ## ADDED Requirements          ### Requirement: <name>   body (SHALL/MUST) + `#### Scenario:` blocks
    ## MODIFIED Requirements       ### Requirement: <name>   write only what should exist after the change (unchanged parts you want to preserve + the changed behavior), including scenarios
    ## REMOVED Requirements        ### Requirement: <name>   name only, no body
    ## RENAMED Requirements        ### Requirement: <old> → <new>   heading change only, content carries over

Rules: ADDED/MODIFIED must have ≥1 scenario. Scenarios use WHEN/THEN format. REMOVED is name-only. RENAMED changes the heading only.

---

## Behavioral Guardrails

- **Verify every file after writing.** Confirm the artifact landed at `outputPath`. If it did not, write it again before moving on.
- **Decide, do not block.** If the user is vague or a detail is unclear, make a reasonable decision and note what you chose in the artifact. The user can correct it during apply or review. But do not skip verification steps — the cross-check and source re-read exist precisely because momentum without checkpoints produces artifacts that look done but aren't.
- **Resume, do not restart.** If the change already exists, check status and continue from the first incomplete artifact. Never overwrite completed work.
- **Suggest patch when appropriate.** If the change is delta-only (a flag, a small behavior tweak, a single requirement), suggest `litespec patch <name> <capability>` instead. Propose is for changes that warrant full planning artifacts.
- **Show a summary when done.** After all artifacts are created, print a brief summary of what was created and the file paths. Then suggest next steps:
  - `apply` to start implementing
  - `review` to review the proposal against specs

**Standing rules check:** During design.md authoring, check whether any language sounds like a cross-cutting rule ("all changes must...", "we will never..."). If so, suggest citing an existing decision from `specs/decisions/` or creating one via `litespec decide <slug>`.

**Backlog graduation:** If `specs/backlog.md` exists, check whether this proposal materializes a backlog item. If so, suggest removing it from the backlog.

**Glossary check:** After writing specs, check whether the specs introduce terms that aren't in `specs/glossary.md`. If so, offer to update the glossary with the new terms. If no glossary exists and the proposal introduces stable shared terms, offer to seed one.

---

## What You Are Doing

Turning conversation and codebase understanding into a structured, actionable change proposal. The four artifacts — proposal, specs, design, tasks — form a contract. Get them on disk, get them right enough, move on.

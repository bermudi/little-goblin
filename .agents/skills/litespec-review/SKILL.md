---
name: litespec-review
description: Adversarial review of litespec artifacts or implementation. Use when the user wants to review a change, check completeness, stress-test implementation against specs, or says 'review' or 'check this'.
---

Enter review mode. You are a QA reviewer, not an implementor. Read specs, read code, find gaps. Report what you can prove.

**IMPORTANT: Review mode is pure review.** You must NEVER write code, modify files, or implement fixes. You read, analyze, and report. If the user asks you to implement something, tell them to exit review mode and use litespec-build.

---

## Setup

Run `litespec status <name> --json` to confirm artifacts exist. The JSON includes `reviewMode` ("artifact", "implementation", or "pre-archive") and `suggestedNextStep` fields.

Read every artifact that exists: proposal.md, specs/, design.md, tasks.md. All are in `specs/changes/<name>/`. State which artifacts were unavailable at the top of the report and exclude dimensions you could not evaluate.

**Determine review mode** from `litespec status <name> --json` field `reviewMode`:
- **artifact** → **Artifact Review** — Read `references/artifact-review.md`
- **implementation** → **Implementation Review** — Read `references/adversarial-review.md` then `references/compliance-review.md` (adversarial first to avoid anchoring)
- **pre-archive** → **Pre-Archive Review** — Read `references/adversarial-review.md`, then `references/compliance-review.md`, then `references/pre-archive-review.md`

**Cross-change dependencies:** Check `.litespec.yaml` for a `dependsOn` field. If present, for each dependency:
1. If the dependency is an active change, read its specs/ and design.md from `specs/changes/<dep-name>/`
2. If the dependency is archived, read its merged specs from `specs/canon/`
3. Also read `specs/glossary.md` if it exists for supplementary terminology context

Keep these dependency artifacts loaded — you will cross-reference them during review.

Do NOT read implementation files for Artifact Review mode. Read all artifacts AND implementation files for the other two modes.

---

## Output Format

Produce the report in this exact structure:

### Missing Artifacts
If any artifacts were unavailable, list them here. State which dimensions could not be fully evaluated.

### Review Mode
State which mode was detected and why (e.g., "Artifact Review: 0 of 6 tasks checked").

### Phase 1: Adversarial Findings
(Implementation and Pre-Archive modes only. Skip for Artifact Review.)

#### Adversarial Scenarios Enumerated
Numbered one-liners: "S1: description", "S2: description", etc.
If Phase 1 was skipped, state `Phase 1 skipped: no stateful code paths detected`.

#### CRITICAL / WARNING / SUGGESTION
Tag each issue with the scenario number it relates to (e.g., "S2: Missing state guard on...").

#### Pattern Annotations
Group findings that share a common structural root. For each pattern:
- **Pattern**: one-line description of the abstract issue (e.g., "unguarded state transition on cancellation", "stale closure over loop variable")
- **Confirmed locations**: `file:line` references already flagged as CRITICAL or WARNING above
- **Likely locations**: `file:line` references that share the same pattern but were not directly triggered by the scenarios you enumerated — the fixer should verify and guard these too
- **Fix guidance**: a single recommendation that addresses all confirmed and likely locations at once (e.g., "Add a unified state-guard check at the top of every method that transitions SubagentInstance status")

Omit this section if no findings share a common pattern.

### Phase 2: Compliance Findings

#### CRITICAL
Issues that mean the implementation is wrong or artifacts have fundamental gaps.
Each issue: **Severity**, **Description**, **Location** (`file:line`), **Recommendation** (specific, actionable).

#### WARNING
Likely wrong but require human judgment. Same format.

#### SUGGESTION
Improvements that would strengthen but are not strictly required. Same format.

### Cross-Change Consistency
(Only if `dependsOn` is present. Skip otherwise.)

Cross-reference interface names, method signatures, config keys, type names, and glossary terms between the reviewed change and its declared dependencies. Report name drift as **WARNING** findings — not CRITICAL. Examples of drift: `EventHandler` vs `Events`, `*RPCAgent` vs `RPCAgent`, `OutputEvent` vs `Event`. The AI performs semantic matching that code cannot do well — affix variants, pluralization, pointer wrappers are all in scope.

### Scorecard
Use the scorecard table from the applicable reference file.

---

## Ending

The report is the output. No follow-up actions from you. The user reads it and decides what to do next. If the user asks you to fix things, tell them to use the build skill (litespec-build).

**Backlog deferral:** If the change explicitly defers scope not already in `specs/backlog.md`, suggest adding deferred items to the backlog.

**Cross-cutting rules:** When reviewing design.md, flag imperative language that reads like a standing architectural ruling ("all subagents must...", "we will never..."). Recommend promoting via `litespec decide <slug>`.

**Cross-change consistency** (when `dependsOn` is present): Cross-reference interface names, method signatures, config keys, type names, and glossary terms against dependency artifacts. Name drift is WARNING severity. Use semantic matching to catch affix variants, pluralization, and pointer wrappers.

